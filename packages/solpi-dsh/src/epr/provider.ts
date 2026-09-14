/**
 * Reducer model call over dsh's LLM service.
 *
 * pi resolves a registry model and calls `registry.complete`; dsh's equivalent
 * one-shot surface is `ctx.llm.stream(GenerateOptions)`, which supports a
 * per-call `system` prompt and needs no `purpose` extension (the closed union
 * stays untouched — the call is an ordinary auxiliary request).
 *
 * Timeout mirrors pi (AbortController + timer, default 90s); stopReason `stop`
 * and `length` both count as usable output exactly like pi's provider.ts.
 */
import { sha256 } from './config.ts'
import type { ArchiveObject } from './archive.ts'
import { reducerInput, reducerInstructions } from './receipt.ts'

export class ReducerModelUnavailableError extends Error {
	override readonly name = 'ReducerModelUnavailableError'

	constructor(message: string) {
		super(message)
	}
}

export interface ProviderResult {
	readonly errorMessage: string | undefined
	readonly model: string
	/** ok when the stream finished cleanly or by length (both yield checkable text). */
	readonly ok: boolean
	readonly outputText: string
	readonly provider: string
	readonly finishReason: string
	readonly totalTokens: number | undefined
	readonly errorName: string | undefined
}

type StreamChunkLike = {
	type: string
	text?: string
	reason?: unknown
	usage?: { totalTokens?: number }
	errorMessage?: string
}

export interface LlmStreamClient {
	stream(options: {
		provider: string
		model: string
		system?: string
		messages: Array<{ role: 'user', content: Array<{ type: 'text', text: string }> }>
		maxTokens?: number
		signal?: AbortSignal
	}): AsyncIterable<StreamChunkLike>
}

/** dsh adapters emit either a bare string or an envelope ({kind|reason}) for the finish signal. */
function normalizeFinishReason(raw: unknown): string {
	if (typeof raw === 'string') return raw
	if (raw !== null && typeof raw === 'object') {
		const r = raw as { reason?: unknown, kind?: unknown }
		if (typeof r.reason === 'string') return r.reason
		if (typeof r.kind === 'string') return r.kind
		return JSON.stringify(raw)
	}
	return String(raw ?? 'unknown')
}

export async function callReducer(
	options: {
		provider: string
		model: string
		maxOutputTokens: number
		timeoutMs: number
		commandSha256: string
		isError: boolean
		archive: ArchiveObject
		body: string
	},
	llm: LlmStreamClient,
	parentSignal?: AbortSignal,
): Promise<ProviderResult> {
	const controller = new AbortController()
	const relayAbort = () => controller.abort(parentSignal?.reason)
	if (parentSignal?.aborted) relayAbort()
	else parentSignal?.addEventListener('abort', relayAbort, { once: true })
	const timer = setTimeout(
		() => controller.abort(new DOMException('Reducer model call timed out', 'AbortError')),
		options.timeoutMs,
	)
	try {
		let text = ''
		let finishReason: string | undefined
		let errorMessage: string | undefined
		let totalTokens: number | undefined
		for await (const chunk of llm.stream({
			provider: options.provider,
			model: options.model,
			system: reducerInstructions(),
			messages: [
				{
					role: 'user',
					content: [{ type: 'text', text: reducerInput(options.commandSha256, options.archive, options.isError, options.body) }],
				},
			],
			maxTokens: options.maxOutputTokens,
			signal: controller.signal,
		})) {
			if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
			else if (chunk.type === 'finish') finishReason = normalizeFinishReason(chunk.reason)
			else if (chunk.type === 'usage') totalTokens = chunk.usage?.totalTokens
		}
		return {
			errorMessage,
			model: options.model,
			ok: finishReason === 'stop' || finishReason === 'length',
			outputText: text,
			provider: options.provider,
			finishReason: finishReason ?? 'none',
			totalTokens,
			errorName: undefined,
		}
	} catch (error) {
		const err = error as { name?: string, message?: string }
		const name = typeof err?.name === 'string' ? err.name : 'Error'
		if (name === 'ReducerModelUnavailableError') throw error
		return {
			errorMessage: err?.message ?? String(error),
			model: options.model,
			ok: false,
			outputText: '',
			provider: options.provider,
			finishReason: name === 'AbortError' ? 'timeout' : 'exception',
			totalTokens: undefined,
			errorName: name,
		}
	} finally {
		clearTimeout(timer)
		parentSignal?.removeEventListener('abort', relayAbort)
	}
}

/** Convenience for callers that already have the command string. */
export function commandSha256(command: string): string {
	return sha256(command)
}
