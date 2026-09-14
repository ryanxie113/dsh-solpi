/**
 * EPR decision journal — append-only JSONL file owned by the plugin.
 *
 * pi appends non-context session entries (`pi.appendEntry`); dsh has no
 * ignorable-plugin-event API, so per the Phase-A storage contract (spec §3.3,
 * "EPR 日志 v1 = 插件根目录下的 journal.jsonl") events land in a file under the
 * store root instead. Entries never enter the LLM context either way.
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export type Journal = (kind: string, data?: Record<string, unknown>) => void

export function createJournal(storeRoot: string, runId: string): Journal {
	let ready: Promise<unknown> | undefined
	return (kind, data = {}) => {
		ready ??= mkdir(storeRoot, { recursive: true, mode: 0o700 }).then(() => undefined)
		const line = JSON.stringify({ schema: 'sol-pi-evidence-preserving-reducer/1', runId, kind, ...data })
		void ready.then(() => appendFile(join(storeRoot, 'journal.jsonl'), `${line}\n`, { mode: 0o600 }))
			.catch(() => {/* journaling must never break the pipeline */})
	}
}
