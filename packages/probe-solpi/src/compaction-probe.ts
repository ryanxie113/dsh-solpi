/**
 * SoL-Pi Phase B probe P6: provide the `compaction` service from a minimal
 * CompactionEngine subclass, replacing dsh-compaction-basic (disabled in the
 * overlay). Class-form default export is the canonical service-provider shape
 * (docs/user/develop/basic/index.md "Three plugin forms").
 *
 * Evidence: boot log lines prove construction and identity; a real agent run
 * emits one compactIfNeeded line per trigger evaluation (pre-step hook chain).
 */

import { createRequire } from 'node:module'

/** Anchored require — see src/index.ts header for why bare imports fail here. */
const req = createRequire('<DSH_INSTALL_ROOT>/packages/compaction/compaction/package.json')
// eslint-disable-next-line @typescript-eslint/naming-convention
const { CompactionEngine } = req('@deepseek-ai/dsh-compaction')

export default class ProbeCompactionEngine extends CompactionEngine {
  static inject = [] as string[]

  constructor(ctx: Context) {
    super(ctx)
    // Trigger wiring is a PROVIDER responsibility (BasicCompactionEngine does
    // the same inside its own constructor): between-step pressure evaluation
    // via agent/pre-step; compactIfNeeded dispatches dynamically to overrides.
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (!signal.aborted) {
        try {
          const result = await this.compactIfNeeded(agent, 'pressure', signal)
          console.log(`[solpi-probe-compaction] pre-step pressure eval done (result=${result === null ? 'null' : 'non-null'})`)
        } catch (error) {
          ctx.logger?.warn?.(`probe compaction failed: ${String(error)}; continuing`)
        }
      }
      return next()
    })
    console.log('[solpi-probe-compaction] ProbeCompactionEngine constructed on service key "compaction"')
  }

  async compactIfNeeded(agent, trigger, signal) {
    console.log(`[solpi-probe-compaction] compactIfNeeded trigger=${trigger} session=${agent?.session?.header?.id ?? '?'}`)
    return null
  }
}
