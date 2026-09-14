/**
 * Candidate identification for the Evidence-Preserving Reducer on dsh.
 *
 * Port of solpi-ext candidate.ts onto dsh's ToolExecution/ToolExecutionResult:
 *   - plain bash results: command from exec.arguments, exact bytes preferred
 *     from `result.value.stdout.spillPath` (dsh mirrors pi's untruncated-file
 *     contract), guarded to a regular non-symlink file under the OS tempdir;
 *   - fused write/edit results (this package's Action Fusion): the command
 *     output appended after the `[then_run:succeeded|failed]` marker.
 */
import { lstat, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute } from 'node:path'

import { isRecord, recordValue } from './config.ts'

/** Markers written by this package's action-fusion around fused command output. */
const THEN_RUN_SUCCEEDED = '[then_run:succeeded]'
const THEN_RUN_FAILED = '[then_run:failed]'

export interface ReducibleToolResult {
	readonly command: string
	readonly body: string
	readonly observedFailure: boolean
	readonly projectReceipt: (receipt: string) => unknown
}

type ExecLike = { readonly name?: string, readonly arguments?: unknown }
type ResultLike = {
	readonly isError?: true
	readonly value?: unknown
	readonly content?: ReadonlyArray<{ type: string, text?: string }>
}

function joinText(content: ResultLike['content']): string {
	return (content ?? [])
		.filter((item): item is { type: 'text', text: string } => item.type === 'text' && typeof item.text === 'string')
		.map((item) => item.text)
		.join('\n')
}

/**
 * Prefer the complete spill file dsh wrote for a large stream, so evidence is
 * checked against the exact bytes the command produced rather than a preview.
 * Guard mirrors pi's safePiBashTempPath adapted to dsh-spill naming.
 */
export async function exactBodyFromInline(inline: string, spillPath: unknown): Promise<string> {
	// Two dsh notices carry the artifact path: bash render's `[... full output: <p>]`
	// and spill-policy's "Full formatted result stored at: <p>. Use read ...".
	const inlineMatch = inline.match(/(?:full output|full formatted result stored at):\s*(.+?)(?:\]\s*\.?|\.\s*Use read\b|$)/iu)
	const raw = typeof spillPath === 'string' && spillPath ? spillPath : inlineMatch?.[1]?.trim()
	if (!raw || !isAbsolute(raw)) return inline
	try {
		const [resolved, root, status] = await Promise.all([realpath(raw), realpath(tmpdir()), lstat(raw)])
		const insideTmpdir = resolved === root || resolved.startsWith(`${root}/`)
		return status.isFile() && !status.isSymbolicLink() && (insideTmpdir || resolved.includes('dsh-spill-'))
			? await readFile(raw, 'utf8')
			: inline
	} catch {
		return inline
	}
}

interface BashValue {
	stdout?: unknown
	exitCode?: number
}

/**
 * Identify the log inside a tool execution/result pair: either a plain bash
 * result, or the command output appended by this package's fused edit/write.
 */
export async function reducibleToolResult(
	exec: ExecLike,
	result: ResultLike,
): Promise<ReducibleToolResult | undefined> {
	if (exec.name === 'bash') {
		const command = recordValue(exec.arguments, 'command')
		if (typeof command !== 'string' || !command) return undefined
		const value = result.value as BashValue | undefined
		const stdout = isRecord(value) ? recordValue(value.stdout, 'spillPath') : undefined
		const inline = joinText(result.content)
		const body = await exactBodyFromInline(inline, stdout)
		const exitCode = typeof value?.exitCode === 'number' ? value.exitCode : undefined
		const observedFailure = result.isError === true || (exitCode !== undefined && exitCode !== 0)
		return {
			command,
			body,
			observedFailure,
			projectReceipt: (receipt) => [{ type: 'text', text: receipt }],
		}
	}
	if (exec.name !== 'write' && exec.name !== 'edit') return undefined
	const thenRun = recordValue(exec.arguments, 'then_run')
	const commandValue = recordValue(thenRun, 'command')
	if (typeof commandValue !== 'string' || !commandValue) return undefined
	const marker = result.isError === true ? THEN_RUN_FAILED : THEN_RUN_SUCCEEDED
	for (let index = 0; index < (result.content ?? []).length; index++) {
		const block = (result.content ?? [])[index]
		if (!block || block.type !== 'text' || typeof block.text !== 'string') continue
		const markerIndex = block.text.indexOf(marker)
		if (markerIndex < 0) continue
		const suffixStart = markerIndex + marker.length
		const suffix = block.text.slice(suffixStart)
		const separator = suffix.match(/^(?:\r?\n)+/u)?.[0] ?? '\n'
		const inline = suffix.startsWith(separator) ? suffix.slice(separator.length) : suffix
		const body = await exactBodyFromInline(inline, undefined)
		const exitCode = recordValue(recordValue(result.value, 'thenRun'), 'exitCode')
		const statusFailed = recordValue(recordValue(result.value, 'thenRun'), 'status') === 'failed'
		return {
			command: commandValue,
			body,
			observedFailure: result.isError === true
				|| statusFailed
				|| (typeof exitCode === 'number' && exitCode !== 0),
			projectReceipt: (receipt) =>
				(result.content ?? []).map((content, contentIndex) =>
					contentIndex === index && content.type === 'text' && typeof content.text === 'string'
						? { ...content, text: `${content.text.slice(0, suffixStart)}${separator}${receipt}` }
						: content,
				),
		}
	}
	return undefined
}
