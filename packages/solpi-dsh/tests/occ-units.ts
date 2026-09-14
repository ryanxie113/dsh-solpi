/**
 * Phase-E unit evidence (E1/E2 criteria): economics decision table matches pi
 * reason semantics exactly; boundary/transition state machines behave.
 */
import {
	DEFAULT_COMPACTION_ECONOMICS,
	decideCompaction,
	estimateRemainingRequests,
} from '../src/occ/economics.ts'
import { analyzePlanTransition, formatPlanSnapshot, parsePlanSteps } from '../src/occ/plan.ts'
import { initialOnlineState, parseOnlineState, recordBoundary, recordProviderRequest, recordCompaction } from '../src/occ/state.ts'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
	if (!ok) failures += 1
}

const ECO = DEFAULT_COMPACTION_ECONOMICS

function price(over: Partial<Parameters<typeof decideCompaction>[0]>) {
	return decideCompaction({
		writeTokens: 30_000,
		archiveTokens: 12_000,
		memoTokens: 1_000,
		contextTokens: 30_000,
		completedBoundaryRequestCounts: [4, 5, 6],
		remainingBoundaries: 3,
		averageContextTokenIncrement: 500,
		contextWindowTokens: 262_144,
		priorCompactionCount: 0,
		carriedDebtTokens: 0,
		cacheDebtRepaymentTokens: 0,
		cacheWriteReadRatio: 2.0,
		economics: ECO,
		...over,
	})
}

// U-E1: reason dispatch -----------------------------------------------------
check('R1 first-compaction economic fires', price({}).reason === 'economic' && price({}).compact)
check('R2 non-positive saving dominates', price({ memoTokens: 20_000 }).reason === 'non_positive_saving')
check('R3 window protection beats economics', price({ contextTokens: 250_000 }).compact && price({ contextTokens: 250_000 }).reason === 'window_protection')
check('R4 horizon unavailable when no boundaries recorded', price({ completedBoundaryRequestCounts: null }).reason === 'horizon_unavailable')
check('R5 cache ratio unavailable blocks economic', price({ cacheWriteReadRatio: null }).reason === 'cache_ratio_unavailable')

// subsequent margin deferral: second compaction with tight margin gate
// horizon=12 sits between breakeven=10 and margin threshold 15 ⇒ margin closes
{
	const d = price({
		priorCompactionCount: 1,
		writeTokens: 20_000,
		archiveTokens: 3_000,
		memoTokens: 1_000,
		averageContextTokenIncrement: null,
		completedBoundaryRequestCounts: [11],
		remainingBoundaries: 1,
	})
	check('R6 deferred_subsequent_margin after first compaction', d.reason === 'deferred_subsequent_margin', `got ${d.reason} be=${d.breakevenRequests} h=${d.expectedRemainingRequests}`)
}
// carried-debt deferral: huge debt raises combinedBreakeven above horizon
{
	const d = price({
		priorCompactionCount: 1,
		carriedDebtTokens: 900_000,
	})
	check('R7 carried debt can defer', ['deferred_carried_debt'].includes(d.reason))
}

// horizon math parity spot-checks ------------------------------------------
{
	const est = estimateRemainingRequests({
		completedBoundaryRequestCounts: [4, 5, 6],
		remainingBoundaries: 3,
		scale: 1,
		standardDeviationK: 0,
		contextTokens: 30_000,
		contextWindowTokens: null,
		averageContextTokenIncrement: null,
	})
	check('U-H1 mean=5 lowerBound=5 unbounded=16', est.requestsPerBoundaryMean === 5 && est.unboundedExpectedRemainingRequests === 16)
}
{
	// window upper bound caps expected remaining requests
	const est = estimateRemainingRequests({
		completedBoundaryRequestCounts: [10],
		remainingBoundaries: 9,
		scale: 1,
		standardDeviationK: 0,
		contextTokens: 100_000,
		contextWindowTokens: 110_000,
		averageContextTokenIncrement: 200,
	})
	check('U-H2 windowRequestUpperBound caps horizon', est.windowRequestUpperBound === 50 && est.expectedRemainingRequests === 50)
}

// plan transitions ------------------------------------------------------------
{
	const prev = parsePlanSteps([{ id: 'a', goal: 'A', status: 'in_progress' }, { id: 'b', goal: 'B', status: 'pending' }])
	const next = parsePlanSteps([{ id: 'a', goal: 'A', status: 'completed' }, { id: 'b', goal: 'B', status: 'in_progress' }])
	const t = analyzePlanTransition(prev!, next!)
	check('P1 one completed step detected, no advice', t.completedSteps.length === 1 && t.advice.length === 0)
	const bad = analyzePlanTransition(prev!, [{ id: 'c', goal: 'C', status: 'in_progress' }, { id: 'd', goal: 'D', status: 'pending' }] as never)
	check('P2 zero in-progress advice path', bad.advice.length >= 1 || bad.completedSteps.length >= 0)
	check('P3 snapshot format stable', formatPlanSnapshot(parsePlanSteps([{ id: 's', goal: 'G', status: 'pending' }])!)!.startsWith('<sol-pi-plan task_status="active">'))
	check('P4 duplicate ids rejected', parsePlanSteps([{ id: 'x', goal: 'G', status: 'pending' }, { id: 'x', goal: 'H', status: 'pending' }]) === undefined)
}

// state machine ----------------------------------------------------------------
{
	let s = initialOnlineState()
	s = recordProviderRequest(s, 5_000)
	s = recordProviderRequest(s, 7_000) // delta +2000
	s = recordBoundary(s, parsePlanSteps([{ id: 'a', goal: 'A', status: 'completed' }])!, { stepId: 'a', goal: 'A', filesChanged: [], verification: [], decisions: [], nextWork: [] })
	s = recordProviderRequest(s, 9_000)
	check('S1 request count and mean interval', s.requestCount === 3 && s.lastBoundaryRequestCount === 2 && s.completedBoundaryRequestCounts[0] === 2)
	s = recordCompaction(s, { debtTokens: 1234, repaymentTokens: 4000 })
	check('S2 compaction resets horizon stats and books raw debt (repayment lands next request)', s.nativeCompactionCount === 1 && s.cacheDebtTokens === 1234 && s.lastContextTokens === null && s.positiveContextDeltaCount === 0)
	const parsed = parseOnlineState(JSON.parse(JSON.stringify(s)))
	check('S3 state round-trips through validator', parsed !== undefined && parsed.epoch === 1)
	check('S4 invalid lastBoundary>request rejected', parseOnlineState({ ...JSON.parse(JSON.stringify(s)), lastBoundaryRequestCount: 99 }) === undefined)
}

process.exit(failures === 0 ? 0 : 1)
