/**
 * Plugin-owned durable telemetry for solpi-dsh (official-readiness hardening).
 *
 * Problem being solved: all four mechanisms currently report only to process
 * stdout (`/tmp/dsh-web.log` style files), which dies with every restart — a
 * long task's forensic trail (e.g. the unresolved "compaction ran without a
 * summary" anomaly, 27 of 80 events in session-dfabc) evaporates.
 *
 * Design constraints inherited from the plugin contract:
 * - Fire-and-forget, always fail-open: telemetry must never break a session.
 *   Every error is swallowed after one per-process console warning.
 * - Lives under `$DSH_HOME/sol-pi/telemetry/events.jsonl`, same storage
 *   contract as OCC state and the EPR store (spec §5.1), mode 0600.
 * - Size-rotated locally (default 2 MB, keep 3 rotations) so it can never
 *   fill a disk. No external log shipper assumed.
 *
 * Event kinds (schema `solpi-dsh-telemetry/1`):
 * - occ-gate       : economics gate decision per pressure check
 * - occ-result     : post-compaction accounting incl. summaryBlocks count,
 *                    which makes "start/end without summary" directly visible
 * - af-then-run    : fused then_run terminal status
 * - epr-applied / epr-skip : receipt pipeline outcomes mirrored from the
 *                    EPR journal for cross-mechanism timelines
 */
import { mkdir, rename, stat, appendFile } from 'node:fs/promises'
import { join } from 'node:path'

import { solPiDir } from './anchors.ts'

export const TELEMETRY_SCHEMA = 'solpi-dsh-telemetry/1'
export const EVENTS_FILE = 'events.jsonl'
const ROTATE_BYTES = 2_000_000
const KEEP_ROTATIONS = 3
const FILE_MODE = 0o600

export type TelemetryEvent = {
	readonly kind: string
	readonly session?: string | undefined
	readonly [field: string]: unknown
}

function resolveDir(): string {
	return solPiDir('telemetry')
}

async function rotateIfNeeded(eventsPath: string): Promise<void> {
	try {
		const info = await stat(eventsPath)
		if (info.size < (rotateBytesOverride ?? ROTATE_BYTES)) return
		for (let i = KEEP_ROTATIONS; i >= 1; i--) {
			const from = i === 1 ? eventsPath : `${eventsPath}.${i - 1}`
			const to = `${eventsPath}.${i}`
			try {
				await rename(from, to)
			} catch {
				// missing source level is fine mid-history
			}
		}
	} catch {
		// first write ever or unreadable file — just try appending
	}
}

/**
 * Append one event. Resolves even on failure (fail-open); failures are
 * counted and surfaced as a single console warning per process.
 */
export function logEvent(event: TelemetryEvent): Promise<void> {
	tail = tail.then(async () => {
		try {
			const dir = resolveDir()
			await mkdir(dir, { recursive: true })
			const eventsPath = join(dir, EVENTS_FILE)
			await rotateIfNeeded(eventsPath)
			const line = JSON.stringify({ t: new Date().toISOString(), schema: TELEMETRY_SCHEMA, ...event }) + '\n'
			await appendFile(eventsPath, line, { mode: FILE_MODE })
		} catch (error) {
			droppedEvents++
			if (!warnedOnce) {
				warnedOnce = true
				console.warn('[solpi-dsh/telemetry] event dropped:', error instanceof Error ? error.message : error)
			}
		}
	})
	return tail
}

/** Diagnostic counters for boot logs/tests (never resets except by reload). */
export function telemetryStats(): { droppedEvents: number } {
	return { droppedEvents }
}

/** Await the in-flight chain — used by tests and shutdown flushes only. */
export async function telemetryFlush(): Promise<void> {
	await tail
}

/* Internal test seams. Do not use in production code paths. */
let tail: Promise<void> = Promise.resolve()
let warnedOnce = false
let droppedEvents = 0
let rotateBytesOverride: number | null = null

export function telemetryResetForTests(): void {
	tail = Promise.resolve()
	droppedEvents = 0
	warnedOnce = false
	rotateBytesOverride = null
}

export function telemetryConfigureForTests(opts: { rotateBytes?: number }): void {
	rotateBytesOverride = opts.rotateBytes ?? null
}
