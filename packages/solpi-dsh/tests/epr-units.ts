/**
 * Phase-D unit evidence for the Evidence-Preserving Reducer (node strip-types).
 *
 *   U1  bash candidate: command + inline body; spillPath preferred over preview
 *   U2  fused write/edit candidate: then_run suffix split + projectReceipt round-trip
 *   U3  gates: DIAGNOSTIC_COMMAND family, minBytes, LIKELY_SECRET
 *   U4  validateReceipt: happy path / schema-mismatch / unverifiable-quote /
 *       missing-failure-evidence
 *   U5  economics: receipt-not-smaller detection in the entry pipeline shape
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { reducibleToolResult, exactBodyFromInline } from '../src/epr/candidate.ts'
import { DIAGNOSTIC_COMMAND, LIKELY_SECRET } from '../src/epr/config.ts'
import { validateReceipt, receiptText } from '../src/epr/receipt.ts'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
	if (!ok) failures += 1
}

const LOG = [
	'cargo build started',
	'error[E0308]: mismatched types at src/main.rs:7',
	'warning: unused variable',
	'build failed',
].join('\n')

const ARCHIVE = { hash: 'a'.repeat(64), bytes: Buffer.byteLength(LOG), chars: LOG.length, lines: 4, path: '/tmp/x.txt' }

// ---- U1 --------------------------------------------------------------------
{
	const r1 = await reducibleToolResult(
		{ name: 'bash', arguments: { command: 'cargo test --workspace' } },
		{ content: [{ type: 'text', text: LOG }] },
	)
	check('U1a plain-bash candidate', r1?.command === 'cargo test --workspace' && r1.body === LOG && !r1.observedFailure)

	const dir = await mkdtemp(join(tmpdir(), 'epr-u1-'))
	try {
		await writeFile(join(dir, 'full.log'), LOG)
		const r2 = await reducibleToolResult(
			{ name: 'bash', arguments: { command: 'cargo test --workspace' } },
			{
				value: { exitCode: 101, stdout: { spillPath: join(dir, 'full.log') } },
				content: [{ type: 'text', text: `${LOG}\n[output truncated; full output: ${join(dir, 'full.log')}]` }],
			},
		)
		check('U1b nonzero exit ⇒ observedFailure', r2?.observedFailure === true && typeof r2.body === 'string')
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

// ---- U2 --------------------------------------------------------------------
{
	const fusedText = `Edited a-file.ts.\n[then_run:succeeded]\ncargo test\n${LOG}`
	const result = {
		value: { before: 'x', after: 'y', thenRun: { status: 'succeeded', output: LOG, exitCode: 0 } },
		content: [{ type: 'text', text: fusedText }],
	}
	const r = await reducibleToolResult({ name: 'edit', arguments: { then_run: { command: 'cargo test' }, oldString: 'x', newString: 'y' } }, result)
	check('U2a fused suffix body extracted', r !== undefined && r.body === `cargo test\n${LOG}`)
	if (r) {
		const projected = r.projectReceipt('RECEIPT-TEXT')
		check('U2b receipt replaces only the marker suffix',
			(projected as Array<{ text?: string }>)[0].text === `Edited a-file.ts.\n[then_run:succeeded]\nRECEIPT-TEXT`)
	}
}

// ---- U3 gates ----------------------------------------------------------------
check('U3a diagnostic regex matches cargo/pytest/pnpm test/make', ['pnpm test --filter x', 'make -j4', 'pytest -q'].every((c) => DIAGNOSTIC_COMMAND.test(c)))
check('U3b diagnostic regex rejects git status/ls', !DIAGNOSTIC_COMMAND.test('git status') && !DIAGNOSTIC_COMMAND.test('ls -la'))
check('U3c likely-secret detector fires', LIKELY_SECRET.test('error trace\napi_key=sk-live-abcdef123456'))

// ---- U4 validateReceipt ------------------------------------------------------
{
	const good = JSON.stringify({
		schema: 'sol-pi-evidence-receipt/1',
		source_sha256: ARCHIVE.hash,
		status: 'failure',
		uncertain: false,
		evidence: [{ kind: 'fatal', quote: 'error[E0308]: mismatched types at src/main.rs:7' }],
	})
	const vGood = validateReceipt(good, ARCHIVE, LOG, true)
	check('U4a valid failure receipt accepted with verified line number',
		vGood.ok === true && vGood.value.evidence[0].line === 2)

	check('U4b fabricated quote rejected', validateReceipt(JSON.stringify({
		schema: 'sol-pi-evidence-receipt/1', source_sha256: ARCHIVE.hash, status: 'failure', uncertain: false,
		evidence: [{ kind: 'fatal', quote: 'this line never existed in any log' }],
	}), ARCHIVE, LOG, true).reason === 'unverifiable-quote')

	check('U4c wrong source hash rejected', validateReceipt(good.replace(ARCHIVE.hash, 'b'.repeat(64)), ARCHIVE, LOG, true).reason === 'schema-mismatch')

	check('U4d success-status on failing log rejected (status-mismatch)', validateReceipt(good, ARCHIVE, LOG, false).reason === 'schema-mismatch')

	const cleanFailNoEvidence = JSON.stringify({
		schema: 'sol-pi-evidence-receipt/1', source_sha256: ARCHIVE.hash, status: 'failure', uncertain: false, evidence: [],
	})
	check('U4e failing log without failure evidence rejected', validateReceipt(cleanFailNoEvidence, ARCHIVE, LOG, true).reason === 'missing-failure-evidence')

	const successEmpty = JSON.stringify({
		schema: 'sol-pi-evidence-receipt/1', source_sha256: ARCHIVE.hash, status: 'success', uncertain: false, evidence: [],
	})
	check('U4f clean success with zero evidence accepted', validateReceipt(successEmpty, ARCHIVE, LOG, false).ok === true)
}

// ---- U5 receipt economics ----------------------------------------------------
{
	const v = validateReceipt(JSON.stringify({
		schema: 'sol-pi-evidence-receipt/1', source_sha256: ARCHIVE.hash, status: 'success', uncertain: false, evidence: [],
	}), ARCHIVE, LOG, false) as { ok: true, value: Parameters<typeof receiptText>[2] }
	const tiny = receiptText('sha-x'.repeat(11), ARCHIVE, v.value, { provider: 'qwen-proxy', model: 'GLM-5.3-Flash', totalTokens: 42 })
	check('U5 receipt smaller than 4096B minBytes threshold ⇒ economically viable for real logs', Buffer.byteLength(tiny) < 4096)
}

// ---- U6: max-tokens blowout + entry-level tight retry (mock stream) --------
{
	const { callReducer } = await import('../src/epr/provider.ts')
	const { reducerInstructions } = await import('../src/epr/receipt.ts')
	const GOOD_JSON = JSON.stringify({
		schema: 'sol-pi-evidence-receipt/1',
		source_sha256: ARCHIVE.hash,
		status: 'failure',
		uncertain: false,
		evidence: [{ kind: 'fatal', quote: 'error[E0308]: mismatched types at src/main.rs:7' }],
	})
	const base = {
		provider: 'mock', model: 'mock-model', maxOutputTokens: 2048,
		timeoutMs: 5_000, commandSha256: 'c'.repeat(64), isError: true, archive: ARCHIVE, body: LOG,
	}
	const seenSystems: string[] = []
	let calls = 0
	function* streamOf(text: string, finish: string): AsyncGenerator<{ type: string, text?: string, reason?: string }> {
		yield { type: 'text-delta', text }
		yield { type: 'finish', reason: finish }
	}
	const llm = {
		async *stream(options: { system?: string }) {
			calls += 1
			seenSystems.push(options.system ?? '')
			if (calls === 1) return yield* streamOf('x'.repeat(4000), 'max-tokens')
			return yield* streamOf(GOOD_JSON, 'stop')
		},
	} as never

	// Single callReducer has NO internal retry (pipeline owns that policy)…
	const single = await callReducer(base, llm as never)
	check('U6a max-tokens finish is not ok at provider level', !single.ok && single.finishReason === 'max-tokens' && calls === 1)
	check('U6b baseline system prompt is the canonical one', seenSystems[0] === reducerInstructions())
	// …the pipeline retries once with tightened constraints; verify the shape.
	const retry = await callReducer({ ...base, tight: true }, llm as never)
	check('U6c tight retry succeeds on second call', calls === 2 && retry.ok && JSON.parse(retry.outputText).schema === 'sol-pi-evidence-receipt/1')
	check('U6d tight retry carries hardened instructions', seenSystems[1]!.includes('exceeded the output budget') && seenSystems[1]!.length > reducerInstructions().length)

	let calls2 = 0
	const llmAlwaysBad = {
		async *stream() {
			calls2 += 1
			return yield* streamOf('y'.repeat(5000), 'max-tokens')
		},
	} as never
	await callReducer(base, llmAlwaysBad as never)
	await callReducer({ ...base, tight: true }, llmAlwaysBad as never)
	check('U6e persistent blowout yields two non-ok provider results', calls2 === 2)
}

process.exit(failures === 0 ? 0 : 1)
