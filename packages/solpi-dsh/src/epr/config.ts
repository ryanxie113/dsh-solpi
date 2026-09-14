/**
 * Evidence-Preserving Reducer constants and configuration for DeepSeek Harness.
 *
 * Verbatim-fidelity port of solpi-ext's evidence-preserving-reducer/config.ts
 * (commit-side values kept identical); provider/model defaults swapped to the
 * composed dsh LLM route, overridable through the entry Config schema.
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export const REDUCER_EVENT_SCHEMA = 'sol-pi-evidence-preserving-reducer/1'
export const REDUCER_RECEIPT_SCHEMA = 'sol-pi-evidence-receipt/1'
export const REDUCER_RECEIPT_PREFIX = 'sol_pi_evidence_receipt_v1'

export const MAX_EVIDENCE_ITEMS = 12
export const MAX_QUOTE_CHARS = 600

const DEFAULT_MIN_BYTES = 4_096
const DEFAULT_MAX_CHARS = 600_000
const DEFAULT_MAX_OUTPUT_TOKENS = 2_048
const DEFAULT_TIMEOUT_MS = 90_000

/** Same diagnostic-command family as pi's v1, extended for dsh's node-native
 * test-runner reality (registered deviation, spec §12.2 #7): bare `node --test`
 * forms are the dominant test invocation in zero-dependency JS projects and
 * were observed producing unreduced diagnostic output in long web tasks
 * (session-dfabc). The extension keeps every pi v1 alternative verbatim. */
export const DIAGNOSTIC_COMMAND
	= /(?:^|[;&|()\s])(?:lake\s+build|lake\s+env\s+lean|lean|coq|cargo(?:\s+(?:build|test|check))?|zig\s+build|pytest|python(?:3)?\s+-m\s+(?:pytest|unittest|py_compile)|ctest|cmake\s+--build|ninja|make|npm\s+test|pnpm\s+test|yarn\s+test|go\s+test|bazel\s+test|node\s+(?:[\w@./=-]+\s+)*--test|npx\s+tsx\s+--test)(?:\s|$)/i

export const FAILURE_SIGNAL = /error|failed|failure|fatal|exception|panic|timeout|unsolved|type mismatch|assert/i
export const LIKELY_SECRET = /(?:api[_-]?key|authorization|bearer|access[_-]?token|secret)[^\n]{0,32}[=:][^\n]+/i

export interface EprConfig {
	readonly maxChars: number
	readonly maxOutputTokens: number
	readonly minBytes: number
	/** dsh GenerateOptions route for the auxiliary reducer call. */
	readonly reducerProvider: string
	readonly reducerModel: string
	readonly runId: string
	readonly storeRoot: string
	readonly timeoutMs: number
}

export function sha256(value: string): string {
	return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function recordValue(value: unknown, key: string): unknown {
	return isRecord(value) ? value[key] : undefined
}

/**
 * Plugin-owned store root under the SoL-Pi home (spec §5.1): the archive and
 * journal are files the plugin owns outright — session jsonl stays untouched.
 * runId follows pi's derivation: hash of the runtime root.
 */
export function loadEprConfig(solPiRoot: string, overrides?: {
	minBytes?: number
	maxChars?: number
	reducerProvider?: string
	reducerModel?: string
	maxOutputTokens?: number
	timeoutMs?: number
}): EprConfig {
	const storeRoot = join(solPiRoot, 'evidence-preserving-reducer')
	return Object.freeze({
		maxChars: overrides?.maxChars ?? DEFAULT_MAX_CHARS,
		maxOutputTokens: overrides?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
		minBytes: overrides?.minBytes ?? DEFAULT_MIN_BYTES,
		reducerProvider: overrides?.reducerProvider ?? 'qwen-proxy',
		reducerModel: overrides?.reducerModel ?? 'GLM-5.3-Flash',
		runId: sha256(storeRoot).slice(0, 16),
		storeRoot,
		timeoutMs: overrides?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	})
}
