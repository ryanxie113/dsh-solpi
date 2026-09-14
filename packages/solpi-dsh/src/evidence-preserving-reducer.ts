/**
 * Evidence-Preserving Reducer — dsh main entry (Phase D port of solpi-ext).
 *
 * Delegates the first read of a long build/test log to the configured reducer
 * model, then verifies what comes back. The raw log is archived under
 * `$DSH_HOME/sol-pi/evidence-preserving-reducer/` (content-addressed, 0600),
 * the model returns ≤12 exact quotes ×≤600 chars, and the receipt is accepted
 * only when every quote is found byte-for-byte in the archive AND the receipt
 * is smaller than the source. Anything else falls open: the original output
 * reaches the frontier agent untouched.
 *
 * Waterfall order note: this entry loads AFTER spill-policy/action-fusion in
 * tree order and prepends its listener, so it fires first; its receipts leave
 * through an early `accept` that bypasses downstream transformers.
 */
import { createRequire } from 'node:module'

import { dshRequire, solPiDir } from './anchors.ts'
import { logEvent } from './telemetry.ts'

const require = dshRequire('@deepseek-ai/dsh-core-tools')
const _zMod = require('@deepseek-ai/schemastery') as { default?: unknown } & Record<string, unknown>
const _z = (_zMod.default ?? _zMod) as {
	object: (shape: Record<string, unknown>) => unknown
	number: () => { optional: () => unknown }
	string: () => { optional: () => unknown }
}

import { archiveBody } from './epr/archive.ts'
import { DIAGNOSTIC_COMMAND, LIKELY_SECRET, loadEprConfig, sha256 } from './epr/config.ts'
import type { EprConfig } from './epr/config.ts'
import { reducibleToolResult } from './epr/candidate.ts'
import { createJournal } from './epr/journal.ts'
import { callReducer } from './epr/provider.ts'
import type { LlmStreamClient } from './epr/provider.ts'
import { receiptText, validateReceipt } from './epr/receipt.ts'

export const name = 'solpi-dsh-epr'

export const inject = ['tools', 'llm']

/** Native config declaration (Phase-D0 finding: parsed even for absolute-path entries). */
export const Config = (_z.object({
	minBytes: _z.number(),
	maxChars: _z.number(),
	reducerProvider: _z.string(),
	reducerModel: _z.string(),
	maxOutputTokens: _z.number(),
	timeoutMs: _z.number(),
}))

type ExecLike = { name?: string, arguments?: unknown }
type ResultLike = {
	isError?: true
	value?: unknown
	content?: ReadonlyArray<{ type: string, text?: string }>
}

type EprOverrides = {
	minBytes?: number
	maxChars?: number
	reducerProvider?: string
	reducerModel?: string
	maxOutputTokens?: number
	timeoutMs?: number
}

export function apply(ctx: unknown, overrides?: EprOverrides): void {
	const c = ctx as {
		on: (event: string, listener: (...args: never[]) => unknown, opts?: { prepend?: boolean }) => void
		llm: LlmStreamClient
	}

	const config: EprConfig = loadEprConfig(solPiDir(), overrides)
	if (!(config.minBytes > 0) || !(config.maxChars >= config.minBytes) || !(config.timeoutMs > 0)) {
		throw new Error(`[solpi-dsh/epr] invalid config: ${JSON.stringify({ minBytes: config.minBytes, maxChars: config.maxChars, timeoutMs: config.timeoutMs })}`)
	}
	const journal = createJournal(config.storeRoot, config.runId)
	console.log(`[solpi-dsh/epr] armed store=${config.storeRoot} reducer=${config.reducerProvider}/${config.reducerModel} minBytes=${config.minBytes}`)

	c.on(
		'tools/post-execute',
		async (exec: ExecLike, result: ResultLike, next: () => Promise<unknown>): Promise<unknown> => {
			try {
				const reducible = await reducibleToolResult(exec, result)
				if (!reducible || !DIAGNOSTIC_COMMAND.test(reducible.command)) return await next()
				const { body, command } = reducible
				void logEvent({ kind: 'epr-skip', reason: 'below-min-bytes', bytes: Buffer.byteLength(body, 'utf8'), minBytes: config.minBytes })
				if (Buffer.byteLength(body, 'utf8') < config.minBytes) return await next()
				if (body.length > config.maxChars) {
					journal('fallback', { reason: 'source-over-max-chars', sourceChars: body.length, maxChars: config.maxChars })
					return await next()
				}
				if (LIKELY_SECRET.test(body)) {
					journal('fallback', { reason: 'likely-secret' })
					return await next()
				}

				const commandSha = sha256(command)
				const archive = await archiveBody(config.storeRoot, body)
				journal('candidate', {
					commandSha256: commandSha,
					sourceSha256: archive.hash,
					sourceBytes: archive.bytes,
					sourceLines: archive.lines,
					sourcePath: archive.path,
				})

				const provider = await callReducer({
					provider: config.reducerProvider,
					model: config.reducerModel,
					maxOutputTokens: config.maxOutputTokens,
					timeoutMs: config.timeoutMs,
					commandSha256: commandSha,
					isError: reducible.observedFailure,
					archive,
					body,
				}, c.llm)

				journal('provider_response', {
					sourceSha256: archive.hash,
					provider: provider.provider,
					model: provider.model,
					finishReason: provider.finishReason,
					errorMessage: provider.errorMessage,
					totalTokens: provider.totalTokens,
				})
				if (!provider.ok) {
					journal('fallback', {
						sourceSha256: archive.hash,
						reason: provider.finishReason === 'timeout' ? 'model-call-timeout' : 'model-response-error',
						errorMessage: provider.errorMessage,
					})
					return await next()
				}

				const checked = validateReceipt(provider.outputText, archive, body, reducible.observedFailure)
				if (!checked.ok) {
					journal('fallback', { sourceSha256: archive.hash, reason: checked.reason })
					return await next()
				}
				const receipt = receiptText(commandSha, archive, checked.value, {
					provider: provider.provider,
					model: provider.model,
					totalTokens: provider.totalTokens ?? -1,
				})
				const receiptBytes = Buffer.byteLength(receipt, 'utf8')
				if (receiptBytes >= archive.bytes) {
					journal('fallback', { sourceSha256: archive.hash, reason: 'receipt-not-smaller', receiptBytes, sourceBytes: archive.bytes })
					return await next()
				}
				journal('applied', {
					commandSha256: commandSha,
					sourceSha256: archive.hash,
					sourceBytes: archive.bytes,
					receiptSha256: sha256(receipt),
					receiptBytes,
					evidenceCount: checked.value.evidence.length,
					uncertain: checked.value.uncertain,
					totalTokens: provider.totalTokens,
				})
				console.log(`[solpi-dsh/epr] applied: ${archive.bytes}B → ${receiptBytes}B receipt (${checked.value.evidence.length} quotes)`)
				void logEvent({ kind: 'epr-applied', sourceBytes: archive.bytes, receiptBytes, evidenceCount: checked.value.evidence.length })
				return { kind: 'accept', content: [{ type: 'text', text: receipt }] }
			} catch (error) {
				// Fail-open always: a reducer defect must never break a user session.
				journal('fallback', { reason: 'pipeline-exception', message: error instanceof Error ? error.message : String(error) })
				console.error('[solpi-dsh/epr] pipeline exception, falling open:', error)
				return await next()
			}
		},
		{ prepend: true },
	)
}
