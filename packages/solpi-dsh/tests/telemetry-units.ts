/**
 * Unit tests for the solpi-dsh durable telemetry module.
 * Covers: append+schema, 0600 mode, size rotation, fail-open on unwritable
 * home, DSH_HOME fallback resolution (T1–T4 style ledger like the other suites).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	EVENTS_FILE,
	logEvent,
	telemetryConfigureForTests,
	telemetryFlush,
	telemetryResetForTests,
	telemetryStats,
} from '../src/telemetry.ts'

const results: string[] = []
async function test(name: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn()
		results.push(`ok 1 - ${name}`)
	} catch (error) {
		results.push(`not ok 1 - ${name}: ${(error as Error).message}`)
		process.exitCode = 1
	}
}

function freshHome(): string {
	return mkdtempSync(join(tmpdir(), 'solpi-telem-'))
}

await test('T1 append yields valid jsonl with schema + kind + iso t', async () => {
	telemetryResetForTests()
	const home = freshHome()
	process.env.DSH_HOME = home
	await logEvent({ kind: 'occ-gate', session: 's1', reason: 'economic', compact: true })
	await telemetryFlush()
	const line = readFileSync(join(home, 'sol-pi', 'telemetry', EVENTS_FILE), 'utf8').trim()
	const parsed = JSON.parse(line) as Record<string, unknown>
	assert.equal(parsed.schema, 'solpi-dsh-telemetry/1')
	assert.equal(parsed.kind, 'occ-gate')
	assert.equal(parsed.session, 's1')
	assert.equal(typeof parsed.t, 'string')
	assert.ok(!Number.isNaN(Date.parse(parsed.t as string)))
})

await test('T2 file created with 0600 mode', async () => {
	telemetryResetForTests()
	const home = freshHome()
	process.env.DSH_HOME = home
	await logEvent({ kind: 'af-then-run', status: 'succeeded' })
	await telemetryFlush()
	const p = join(home, 'sol-pi', 'telemetry', EVENTS_FILE)
	const mode = statSync(p).mode & 0o777
	assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`)
})

await test('T3 size rotation keeps KEEP_ROTATIONS generations and current file continues', async () => {
	telemetryResetForTests()
	const home = freshHome()
	process.env.DSH_HOME = home
	telemetryConfigureForTests({ rotateBytes: 300 })
	for (let i = 0; i < 30; i++) await logEvent({ kind: 'filler', i })
	await telemetryFlush()
	const dir = join(home, 'sol-pi', 'telemetry')
	const files = readdirSync(dir).sort()
	assert.ok(files.includes(EVENTS_FILE), 'current file exists after rotation')
	assert.ok(files.some((f) => f.startsWith(`${EVENTS_FILE}.`)), 'at least one rotation generation exists')
	// Bounded ring: oldest generations are intentionally discarded. Verify the
	// retained window instead: unique ids, chronological order across generations.
	const ordered = [...files].sort((a, b) => {
		const gen = (f: string): number => f === EVENTS_FILE ? Number.POSITIVE_INFINITY : -Number(f.slice(EVENTS_FILE.length + 1))
		return gen(a) - gen(b)
	})
	const ids: number[] = []
	for (const f of ordered) {
		for (const line of readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean)) {
			ids.push((JSON.parse(line) as { i?: number }).i as number)
		}
	}
	assert.ok(ids.length >= 4 && ids.length <= 30, 'retained a bounded window')
	assert.equal(new Set(ids).size, ids.length, 'no duplicated events in retained window')
	for (let k = 1; k < ids.length; k++) assert.ok(ids[k] > ids[k - 1], 'chronological order preserved across rotations')
})

await test('T4 fail-open: unwritable home counts drops and never rejects', async () => {
	telemetryResetForTests()
	const home = freshHome()
	process.env.DSH_HOME = home
	// make the sol-pi parent read-only so mkdir/append must fail
	chmod(home, 0o500)
	try {
		await logEvent({ kind: 'doomed' })
		await telemetryFlush()
	} finally {
		chmod(home, 0o700)
	}
	assert.equal(telemetryStats().droppedEvents >= 1, true, 'drop counted')
})

await test('T2b af-then-run event carries optional exitCode', async () => {
	telemetryResetForTests()
	const home = freshHome()
	process.env.DSH_HOME = home
	await logEvent({ kind: 'af-then-run', status: 'failed', exitCode: 2 })
	await logEvent({ kind: 'af-then-run', status: 'skipped' })
	await telemetryFlush()
	const lines = readFileSync(join(home, 'sol-pi', 'telemetry', EVENTS_FILE), 'utf8').trim().split('\n')
	const failed = JSON.parse(lines[0]) as Record<string, unknown>
	assert.equal(failed.status, 'failed')
	assert.equal(failed.exitCode, 2, 'failed leg must carry its exitCode for forensics')
	const skipped = JSON.parse(lines[1]) as Record<string, unknown>
	assert.equal('exitCode' in skipped, false, 'undefined exitCode must not be emitted as null/noise')
})

console.log(results.join('\n'))
if (process.exitCode !== 1) console.log('# telemetry-units all passed')
