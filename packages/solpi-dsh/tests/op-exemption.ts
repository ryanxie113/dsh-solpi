/**
 * Phase-D C7 evidence: observation-pack's receipt-exemption listener shields
 * `sol_pi_evidence_receipt_v1`-prefixed results from downstream transformers.
 */
import { apply } from '../src/observation-pack.ts'

let captured: ((exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
const fakeCtx = {
	on: (event: string, listener: typeof captured, _opts?: { prepend?: boolean }) => {
		if (event === 'tools/post-execute') captured = listener
	},
}
apply(fakeCtx as never, { maxInlineBytes: 10240 })

let failures = 0
function check(label: string, ok: boolean) {
	console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
	if (!ok) failures += 1
}

if (!captured) {
	console.log('FAIL listener not registered')
	process.exit(1)
}

const RECEIPT = 'sol_pi_evidence_receipt_v1\nstatus=success\nverified_evidence:\n- none'
let nextCalls = 0

// Receipt-bearing result ⇒ early accept WITHOUT calling next().
{
	nextCalls = 0
	const decision = await captured!({}, { content: [{ type: 'text', text: RECEIPT }] }, async () => {
		nextCalls++
		return { kind: 'accept' }
	})
	check('receipt ⇒ early accept, downstream skipped', JSON.stringify(decision) === '{"kind":"accept"}' && nextCalls === 0)
}

// Ordinary result ⇒ pass-through via next().
{
	nextCalls = 0
	const decision = await captured!({}, { content: [{ type: 'text', text: 'plain tool output' }] }, async () => {
		nextCalls++
		return { kind: 'accept', value: 'downstream-decided' }
	})
	check('ordinary ⇒ delegated to next()', nextCalls === 1 && (decision as { value?: string })?.value === 'downstream-decided')
}

// Spill notice containing the word but not at block start ⇒ NOT exempted (prefix discipline).
{
	nextCalls = 0
	await captured!({}, { content: [{ type: 'text', text: `see ${RECEIPT.slice(0, 12)} format guide` }] }, async () => {
		nextCalls++
		return { kind: 'accept' }
	})
	check('mid-text mention ⇒ not exempted', nextCalls === 1)
}

process.exit(failures === 0 ? 0 : 1)
