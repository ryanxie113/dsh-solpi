/**
 * SoL-Pi Online Context Compact — dsh integration entry (Phase E, decision "A").
 *
 * Integration strategy: subclass the stock BasicCompactionEngine so ALL replay/
 * region/summary mechanics (and overflow recovery) are inherited unchanged, and
 * override ONLY the pressure gate with SoL-Pi economics:
 *
 *   pre-step('pressure')
 *     ├─ measure context via tokenMeter
 *     ├─ decideCompaction(...) with plan-boundary horizon + carried cache debt
 *     ├─ gate closed  → log reason, return null (no compaction)
 *     └─ gate open    → super.compactIfNeeded(...) runs stock mechanics
 *
 * Boundary source: our own `solpi_update_plan` tool (dsh has no native step-list
 * tool). Completed steps record boundary request-intervals; horizon math and
 * POST_COMPACTION_PLAN_REMINDER follow pi verbatim. The reminder is FOLDED into
 * the summary blocks (documented deviation: no separate steering message seam).
 *
 * State persists per session id as a plugin-owned JSON file under
 * `$DSH_HOME/sol-pi/online-context-compact/` (best-effort, never throws).
 */
import { dshRequire, regionModuleUrl, solPiDir } from './anchors.ts'
const require = dshRequire('@deepseek-ai/dsh-core-tools')
const { defineTool } = require('@deepseek-ai/dsh-tools') as { defineTool: (def: Record<string, unknown>) => Record<string, unknown> }
const _zMod = require('@deepseek-ai/schemastery') as { default?: unknown } & Record<string, unknown>
const z = (_zMod.default ?? _zMod) as {
	object: (shape: Record<string, unknown>) => unknown
	number: () => Record<string, unknown>
	string: () => Record<string, unknown>
	boolean: () => Record<string, unknown>
}
const BasicCtor = dshRequire('@deepseek-ai/dsh-compaction-basic')(
	'@deepseek-ai/dsh-compaction-basic',
).default as new (ctx: unknown, config?: Record<string, unknown>) => unknown

/** Resolved once at module load: `<DSH_HOME>/sol-pi` storage root. */
const solPiCache: string = solPiDir()

import { DEFAULT_COMPACTION_ECONOMICS, decideCompaction } from './occ/economics.ts'
import type { CompactionDecision } from './occ/economics.ts'
import { analyzePlanTransition, formatPlanSnapshot, parsePlanSteps } from './occ/plan.ts'
import type { PlanStep } from './occ/plan.ts'
import { OnlineStateStore, initialOnlineState, recordBoundary, recordCompaction, recordProviderRequest, recordSummarizerFailure } from './occ/state.ts'
import type { OnlineState, ProgressSummary } from './occ/state.ts'
import { logEvent } from './telemetry.ts'

export const name = 'solpi-dsh-occ'

export const inject = ['llm', 'tokenMeter', 'sessions', 'tools']

export const Config = z.object({
	thresholdRatio: z.number(),
	retainRatio: z.number(),
	retainTokens: z.number(),
	summarizationProvider: z.string(),
	summarizationModel: z.string(),
	maxTokens: z.number(),
	compactionRetries: z.number(),
	maxOverflowRetries: z.number(),
	auto: z.boolean(),
	keepRecentTokens: z.number(),
	cacheWriteReadRatio: z.number(),
	summaryTokenEstimate: z.number(),
})

/** pi-verbatim reminder text. */
export const POST_COMPACTION_PLAN_REMINDER =
	'Online context compaction finished. The parent task is still active. '
	+ 'Before continuing work, call solpi_update_plan with a fresh plan for the remaining work.'

export const DEFAULT_KEEP_RECENT_TOKENS = 20_000
export const DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE = 1_000

interface OccConfig {
	keepRecentTokens?: number
	cacheWriteReadRatio?: number | null
	summaryTokenEstimate?: number
}

type AgentLike = {
	session: {
		id: string
		surface?: unknown
		requestHeader?: () => { config?: { provider?: string, model?: string } }
	}
	options?: { provider?: string, model?: string }
}

/** Deep-imported stock machinery (exports map allows ./src/*); loaded lazily. */
let regionFns: {
	selectCompactableRange: (session: never, measurement: never, retainTokens: number) => { start: number, end: number } | null
} | undefined
async function loadRegionFns(): Promise<NonNullable<typeof regionFns>> {
	regionFns ??= await import(regionModuleUrl()) as never
	return regionFns
}

/** Synchronous read of the pre-resolved SoL-Pi storage root (constructor-resolved). */
function solPiRootCached(...segments: readonly string[]): string {
	if (solPiCache === null) throw new Error('[solpi-dsh/occ] sol-pi root resolved too late — plugin constructor did not run?')
	const { join } = require('node:path') as { join: (...p: string[]) => string }
	return join(solPiCache, ...segments)
}

type CtxLike = {
	on: (event: string, listener: (...args: never[]) => unknown, opts?: { prepend?: boolean }) => void
	tokenMeter: { measure: (session: unknown) => { totalTokens: number } }
	llm: { resolveModelInfo?: (provider: string, model: string, signal?: AbortSignal) => Promise<{ context?: { contextWindow?: number } }> }
	tools: { register: (tool: unknown) => void }
	logger?: { info: (...args: unknown[]) => void, warn: (...args: unknown[]) => void }
}

function tokenEstimate(text: string): number {
	return Math.ceil(Buffer.byteLength(text, 'utf8') / 4)
}

class SolpiCompactionEngine extends BasicCtor {
	static inject = ['llm', 'tokenMeter', 'sessions', 'tools']

	private occ!: Required<Pick<OccConfig, 'keepRecentTokens' | 'summaryTokenEstimate'>> & { cacheWriteReadRatio: number | null }
	private stores = new Map<string, OnlineStateStore>()
	private storeKey: string | undefined
	private state: OnlineState = initialOnlineState()
	private lastDebt: { debtTokens: number, repaymentTokens: number } | null = null
	private reminderDue = false

	constructor(ctx: unknown, config: OccConfig & Record<string, unknown> = {}) {
		const { keepRecentTokens, cacheWriteReadRatio, summaryTokenEstimate, ...basicConfig } = config
		const keepRecent = keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS
		super(ctx, basicConfig)
		const c = ctx as CtxLike
		this.ctx = c as unknown as CtxLike & Record<string, unknown>
		this.occ = {
			keepRecentTokens: keepRecent,
			summaryTokenEstimate: summaryTokenEstimate ?? DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE,
			cacheWriteReadRatio: cacheWriteReadRatio === undefined ? null : cacheWriteReadRatio,
		}

		// One provider response ≈ one request, mirroring basic's own overflow-reset hook.
		c.on('session/event', ((session: AgentLike['session'], event: { type?: string }) => {
			if (event.type !== 'assistant/message' || typeof session?.id !== 'string') return
			this.ensureStore(session.id)
			let tokens = this.state.lastContextTokens ?? 0
			try {
				tokens = c.tokenMeter.measure(session as never).totalTokens
			} catch {
				/* measurement must not break event flow */
			}
			this.state = recordProviderRequest(this.state, tokens)
			void this.persist()
		}) as never)

		this.registerPlanTool(c)

		console.log(`[solpi-dsh/occ] mounted over ${BasicCtor.name}; keepRecent=${this.occ.keepRecentTokens} ratio=${this.occ.cacheWriteReadRatio}`)
	}

	/* ---------- state plumbing ---------- */

	private ensureStore(sessionId: string): void {
		if (this.storeKey !== sessionId) {
			let store = this.stores.get(sessionId)
			if (store === undefined) {
				store = new OnlineStateStore(solPiRootCached('online-context-compact'), sessionId)
				this.stores.set(sessionId, store)
				void store.load().then((loaded) => {
					if (this.storeKey === sessionId && loaded.requestCount > this.state.requestCount) {
						this.state = loaded
						void this.persist()
					}
				})
			}
			this.storeKey = sessionId
			// Start each session's in-memory state fresh, then let async load win if richer.
			this.state = initialOnlineState()
		}
	}

	private persist(): Promise<void> {
		return this.storeKey !== undefined
			? (this.stores.get(this.storeKey) ?? new OnlineStateStore('', this.storeKey)).save(this.state)
			: Promise.resolve()
	}

	/* ---------- pressure gate (the OCC delta) ---------- */

	override async compactIfNeeded(agent: AgentLike, trigger: string, signal?: AbortSignal): Promise<unknown> {
		if (trigger !== 'pressure') return await super.compactIfNeeded(agent as never, trigger as never, signal as never)
		const target = this.routedTarget(agent)
		if (target === undefined) return null
		this.ensureStore(agent.session.id)
		const measurement = this.ctx.tokenMeter.measure(agent.session)
		const writeTokens = measurement.totalTokens
		let windowTokens: number | null = null
		try {
			const info = await this.ctx.llm.resolveModelInfo!(target.provider, target.model, signal)
			windowTokens = info.context?.contextWindow ?? null
		} catch {
			windowTokens = null
		}
		const archiveTokens = Math.max(0, writeTokens - this.occ.keepRecentTokens)
		const averageContextTokenIncrement
			= this.state.positiveContextDeltaCount === 0
				? null
				: this.state.positiveContextDeltaTotal / this.state.positiveContextDeltaCount

		const decision: CompactionDecision = decideCompaction({
			writeTokens,
			archiveTokens,
			memoTokens: this.occ.summaryTokenEstimate,
			contextTokens: writeTokens,
			completedBoundaryRequestCounts: this.state.completedBoundaryRequestCounts,
			remainingBoundaries: this.state.plan.filter((step) => step.status !== 'completed').length,
			averageContextTokenIncrement,
			contextWindowTokens: windowTokens,
			priorCompactionCount: this.state.nativeCompactionCount,
			carriedDebtTokens: Math.max(0, this.state.cacheDebtTokens - this.state.cacheDebtRepaymentTokens),
			cacheDebtRepaymentTokens: this.state.cacheDebtRepaymentTokens,
			cacheWriteReadRatio: this.occ.cacheWriteReadRatio,
			economics: DEFAULT_COMPACTION_ECONOMICS,
		})

		// Circuit breaker: after consecutive summarizer failures (observed on
		// GLM Flash in benchmark T3: five straight token-cap truncations burned
		// ~100s of retry), stop paying for compaction this session — fail open
		// to vanilla and let the pressure path handle the window instead.
		if (this.state.summarizerFailures >= 2) {
			void logEvent({ kind: 'occ-gate', session: agent.session.id, reason: 'summarizer_circuit_open', writeTokens, archiveTokens, horizon: 0, breakeven: null, compact: false })
			return null
		}

		console.log(`[solpi-dsh/occ] gate=${decision.reason} write=${writeTokens} archive=${archiveTokens} horizon=${decision.expectedRemainingRequests} breakeven=${decision.breakevenRequests}`)
		void logEvent({ kind: 'occ-gate', session: agent.session.id, reason: decision.reason, writeTokens, archiveTokens, horizon: decision.expectedRemainingRequests, breakeven: decision.breakevenRequests, compact: decision.compact })
		if (!decision.compact) return null

		this.lastDebt = {
			debtTokens: Math.round(writeTokens * (decision.incrementalCacheCostRatio ?? 0)),
			repaymentTokens: Math.max(0, decision.archiveTokens - decision.memoTokens),
		}
		this.reminderDue = true

		// Execute with stock machinery PARTS directly — the inherited pressure
		// branch re-applies its own ratio threshold which would veto
		// economically-opened decisions (integration bug found in user web
		// testing). Loop mirrors BasicCompactionEngine.pressure semantics minus
		// the threshold: prune → selectCompactableRange(keepRecent) → compact →
		// remeasure, until archive no longer positive or retries exhausted.
		const { selectCompactableRange } = await loadRegionFns()
		const meter = this.ctx.tokenMeter
		let measured = meter.measure(agent.session)
		const prune = (this.ctx as unknown as { get?: (name: string) => { pruneSession: (s: unknown) => void } | undefined }).get?.('toolResultPruner')
		if (prune) {
			prune.pruneSession(agent.session)
			measured = meter.measure(agent.session)
		}
		const retries = (this as unknown as { config?: { compactionRetries?: number } }).config?.compactionRetries ?? 0
		let result: unknown = null
		let attempts = 0
		for (let attempt = 0; attempt <= retries; attempt++) {
			const range = selectCompactableRange(agent.session as never, measured as never, this.occ.keepRecentTokens)
			if (range === null) break
			try {
				attempts++
				result = await this.compactRegion(range.start, range.end, agent as never, signal)
			} catch (error) {
				// Durable-progress philosophy: keep an already-landed compaction and
				// stop; a first-attempt failure surfaces to the caller's warning path.
				if (result !== null || signal?.aborted) break
				this.state = recordSummarizerFailure(this.state)
				await this.persist()
				throw error
			}
			measured = meter.measure(agent.session)
			if (Math.max(0, measured.totalTokens - this.occ.keepRecentTokens) <= this.occ.summaryTokenEstimate) break
		}
		if (result !== null && !signal?.aborted) {
			this.state = recordCompaction(this.state, this.lastDebt)
			await this.persist()
			const summaryBlocks = Array.isArray((result as { summary?: unknown } | null)?.summary)
				? ((result as { summary: unknown[] }).summary.length)
				: null
			void logEvent({ kind: 'occ-result', session: agent.session.id, epoch: this.state.epoch, attempts, summaryBlocks, totalAfter: measured.totalTokens })
		}
		return result
	}

	private routedTarget(agent: AgentLike): { provider: string, model: string } | undefined {
		const routed = agent.session.requestHeader?.()?.config
		if (routed?.provider && routed.model) return { provider: routed.provider, model: routed.model }
		if (agent.options?.provider && agent.options.model) return { provider: agent.options.provider, model: agent.options.model }
		return undefined
	}

	/* ---------- summary hook: fold the plan reminder in ---------- */

	protected override async summarize(input: unknown, agent: unknown, signal?: AbortSignal): Promise<unknown> {
		const result = (await super.summarize(input as never, agent as never, signal)) as {
			summary: Array<{ type: string, text?: string }>
		}
		if (this.reminderDue) {
			this.reminderDue = false
			result.summary = result.summary.map((block) =>
				block.type === 'text' && typeof block.text === 'string'
					? { ...block, text: `${block.text}\n\n${POST_COMPACTION_PLAN_REMINDER}` }
					: block,
			)
			console.log('[solpi-dsh/occ] plan reminder folded into summary block')
		}
		return result
	}

	/* ---------- boundary source tool ---------- */

	private registerPlanTool(c: CtxLike): void {
		type PlanArgs = {
			steps?: unknown
			progress?: { files_changed?: string[], verification?: string[], decisions?: string[], next_work?: string[] }
		}
		c.tools.register(defineTool({
			name: 'solpi_update_plan',
			description:
				'Replace the complete working plan. A newly completed step becomes a safe point where SoL-Pi may compact context if doing so is economical.',
			parameters: {
				steps: {
					type: 'array',
					required: true,
					items: {
						type: 'object',
						additionalProperties: false,
						properties: {
							id: { type: 'string', required: true, description: 'Stable step id' },
							goal: { type: 'string', required: true, description: 'What this step accomplishes' },
							status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed'] },
						},
					},
					description: 'Complete list of plan steps.',
				},
				progress: {
					type: 'object',
					additionalProperties: false,
					description: 'Optional evidence for just-completed steps.',
					properties: {
						files_changed: { type: 'array', items: { type: 'string' } },
						verification: { type: 'array', items: { type: 'string' } },
						decisions: { type: 'array', items: { type: 'string' } },
						next_work: { type: 'array', items: { type: 'string' } },
					},
				},
			},
			output: {
				schema: { type: 'string' },
				render: (_args: unknown, value: string) => [{ type: 'text', text: String(value) }],
			},
			execute: async (args: PlanArgs, exec?: { agent?: { session?: { id?: string } } }) => {
				const next = parsePlanSteps(args.steps) as readonly PlanStep[] | undefined
				if (next === undefined) throw new Error('invalid steps payload: expect [{id, goal, status}], ≤128 steps, unique ids')
				const p = args.progress
				const transition = analyzePlanTransition(this.state.plan, next)
				const completedSteps = transition.completedSteps
				const boundary = completedSteps.length > 0
				this.ensureStore(exec?.agent?.session?.id ?? 'adhoc')
				const last = boundary ? completedSteps[completedSteps.length - 1]! : undefined
				const progress: ProgressSummary | undefined = last === undefined && p === undefined
					? undefined
					: {
						stepId: last?.id ?? '',
						goal: last?.goal ?? '',
						filesChanged: p?.files_changed ?? [],
						verification: p?.verification ?? [],
						decisions: p?.decisions ?? [],
						nextWork: p?.next_work ?? [],
					}
				if (boundary) {
					this.state = recordBoundary(this.state, next, progress)
				} else {
					this.state = { ...this.state, plan: [...next], pendingProgress: progress ? [...this.state.pendingProgress, progress] : this.state.pendingProgress }
				}
				await this.persist()
				const snapshot = formatPlanSnapshot(next)
				const advice = transition.advice.length > 0 ? `\n${transition.advice.join('\n')}` : ''
				console.log(`[solpi-dsh/occ] update_plan boundary=${boundary} steps=${next.length}`)
				return `${snapshot}${advice}`
			},
		}))
	}
}

export default SolpiCompactionEngine
