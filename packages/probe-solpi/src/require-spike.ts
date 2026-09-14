/**
 * Spike 3: async-apply dynamic import of raw TS source from another package.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const PKG = '<DSH_INSTALL_ROOT>/packages/fs/tool-fs/package.json'
const SRC = '<DSH_INSTALL_ROOT>/packages/fs/tool-fs/src/'

export const name = 'solpi-require-spike'

export async function apply(ctx: unknown): Promise<void> {
  const req = createRequire(PKG)
  const sandboxMod = await import(pathToFileURL(`${SRC}sandbox.ts`).href)
  const diffMod = await import(pathToFileURL(`${SRC}diff.ts`).href)

  console.log('[solpi-spike] main entry resolves to:', req.resolve('@deepseek-ai/dsh-tool-fs'))
  console.log('[solpi-spike] dynamic import sandbox.ts OK:',
    typeof (sandboxMod as Record<string, unknown>).FsSandboxController === 'function')
  console.log('[solpi-spike] dynamic import diff.ts OK:',
    typeof (diffMod as Record<string, unknown>).computeHunkDiffs === 'function')
}
