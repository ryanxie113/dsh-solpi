/**
 * Phase-E E6 regression: EPR's exact-body preference picks up the FULL bytes
 * from a >64KB dsh-spill artifact (real tmpdir layout), and refuses symlinked
 * or out-of-pattern paths (fail to inline, fail-open semantics preserved).
 */
import { mkdir, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { exactBodyFromInline } from '../src/epr/candidate.ts'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
	if (!ok) failures += 1
}

// Raw stdout larger than bash's 64KB inline cap ⇒ truncated + spillPath.
const BODY = Array.from({ length: 1400 }, (_, i) => `epr-spill-regression line ${String(i).padStart(4, '0')} ${'y'.repeat(40)}`).join('\n') + '\n'
const PREVIEW = `${BODY.slice(0, 200)}\n(Omitted lots. Full formatted result stored at: PLACEHOLDER. Use read with offset/limit.)`

const dir = join(tmpdir(), `dsh-spill-e6reg/session-${'a'.repeat(12)}`)
await mkdir(dir, { recursive: true, mode: 0o700 })
const artifact = join(dir, 'ba2cefbba776-bash.txt')
await writeFile(artifact, BODY)

{
	const got = await exactBodyFromInline(PREVIEW.replace('PLACEHOLDER', artifact), artifact)
	check('E6a full 70KB-class bytes retrieved from spillPath', got === BODY, `${got.length} vs ${BODY.length}`)
	const got2 = await exactBodyFromInline(PREVIEW.replace('PLACEHOLDER', artifact), undefined) // inline marker path only
	check('E6b inline "full output:" fallback also resolves the file', got2 === BODY)
}
{
	// Symlinked artifact must NOT be trusted.
	const outside = join(tmpdir(), `epr-sneaky-${process.pid}.txt`)
	await rm(outside, { force: true })
	await writeFile(outside, 'TAMPERED')
	await symlink(outside, join(dir, 'sneaky-bash.txt'))
	const pv = PREVIEW.replace('PLACEHOLDER', join(dir, 'sneaky-bash.txt'))
	const got = await exactBodyFromInline(pv, join(dir, 'sneaky-bash.txt'))
	check('E6c symlink rejection falls back to inline preview', got === pv)
	await rm(outside, { force: true })
}
{
	// Non-absolute junk stays inline.
	check('E6d relative path ignored', (await exactBodyFromInline('PREVIEW', './relative.log')) === 'PREVIEW')
}

await rm(join(tmpdir(), 'dsh-spill-e6reg'), { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
