/**
 * Unit evidence for Action Fusion's two mechanical guarantees, run standalone
 * under node's type stripping (v22.19+):
 *
 *   T1/T2  withFusedFileQueue serializes same-canonical-path work and allows
 *          cross-path concurrency.
 *   T3     assertUnchangedBeforeCommand skips the command when the target
 *          changes during its interference-yield window, passes otherwise.
 */
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { withFusedFileQueue } from '../src/file-queue.ts'
import { THEN_RUN_SKIPPED, assertUnchangedBeforeCommand } from '../src/then-run.ts'

let failures = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

// ---- T1: same-path serialization -----------------------------------------
{
  const events = []
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const sharedPath = '/tmp/af-t1-same.txt'
  const a = withFusedFileQueue(sharedPath, async () => {
    events.push('a-enter')
    await sleep(50)
    events.push('a-exit')
  })
  const b = withFusedFileQueue(sharedPath, async () => {
    events.push('b-enter')
    await sleep(10)
    events.push('b-exit')
  })
  await Promise.all([a, b])
  check('T1 same-path strictly serialized',
    events.join(',') === 'a-enter,a-exit,b-enter,b-exit', events.join(','))
}

// ---- T2: cross-path concurrency -------------------------------------------
{
  const active = new Set()
  let overlapped = false
  const work = (name) => withFusedFileQueue(`/tmp/af-t2-${name}.txt`, async () => {
    if (active.size > 0) overlapped = true
    active.add(name)
    await new Promise((r) => setTimeout(r, 30))
    active.delete(name)
  })
  await Promise.all([work('p'), work('q'), work('r')])
  check('T2 distinct paths run concurrently', overlapped)
}

// ---- T3: interference guard -------------------------------------------------
{
  const dir = await mkdtemp(join(tmpdir(), 'af-guard-'))
  const p = join(dir, 'target.txt')
  try {
    await writeFile(p, 'stable')
    let threw = null
    try {
      await assertUnchangedBeforeCommand(p, async () => {
        await writeFile(p, 'TAMPERED')
      })
    } catch (e) { threw = e }
    check('T3a tamper during yield ⇒ skipped-marker error',
      threw !== null && String(threw.message).includes(THEN_RUN_SKIPPED),
      threw?.message?.slice(0, 80))

    let cleanThrew = false
    try { await assertUnchangedBeforeCommand(p) } catch { cleanThrew = true }
    check('T3b untouched target passes guard', !cleanThrew)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

process.exit(failures === 0 ? 0 : 1)
