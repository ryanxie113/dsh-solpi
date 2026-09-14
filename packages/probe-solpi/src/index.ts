/**
 * SoL-Pi Phase B probe plugin for DeepSeek Harness @ commit c291e79.
 *
 * Validates three seams with ONE composition-mounted listener:
 *   P1 loading      — boot-time side effect (log line + tool registration)
 *   P2 interception — `tools/post-execute` prepend listener appends
 *                     `[solpi-probe]` to an accepted text result
 *   P3 archive face — same listener stores the FULL pre-marker text through
 *                     `ctx.spillStore.saveText` and appends the returned
 *                     locator/retrievalHint as a second probe line
 *
 * Constraint note (why `createRequire` instead of bare imports): this file is
 * loaded from outside the dsh checkout, so ESM parent-walk cannot reach the
 * harness dependency closure. All runtime dependencies are resolved through a
 * require anchored INSIDE the locked checkout (`packages/core/tools`, whose
 * package graph carries @deepseek-ai/dsh-tools and schemastery). Type-only
 * needs are avoided entirely — no value imports of dsh packages here.
 */

import { createRequire } from 'node:module'

/** Locked dsh checkout anchor (Phase B pins c291e7961a515f6d7af9304e7fd1d257929aef26). */
const DSH_ANCHOR = '<DSH_INSTALL_ROOT>/packages/core/tools/package.json'

export const name = 'solpi-probe'

export const inject = ['tools']

export function apply(ctx: Context): void {
  console.log('[solpi-probe] apply() entered; tools service ready =', ctx.tools !== undefined)

  const req = createRequire(DSH_ANCHOR)
  let defineTool: (def: Record<string, unknown>) => Record<string, unknown>
  try {
    ;({ defineTool } = req('@deepseek-ai/dsh-tools'))
  } catch (error) {
    console.error('[solpi-probe] FATAL cannot resolve @deepseek-ai/dsh-tools from', DSH_ANCHOR, error)
    throw error
  }
  console.log('[solpi-probe] defineTool resolved:', typeof defineTool === 'function')

  ctx.tools.register(defineTool({
    name: 'solpi_probe_echo',
    description: 'Echo a greeting back. Probe-only tool; always safe to call.',
    parameters: {
      name: { type: 'string', required: true, description: 'Who to greet' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: string) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { name: string }) {
      return `Hello, ${args.name}! This line comes from the solpi-probe tool body.`
    },
  }))
  console.log('[solpi-probe] registered tool solpi_probe_echo')

  /**
   * P2/P3 listener. Scope gate: only our own echo tool, so evidence stays
   * deterministic and other traffic passes byte-identical.
   */
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (exec.name !== 'solpi_probe_echo') return decision
    if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision

    const blocks = decision.content ?? result.content ?? []
    const text = blocks.map((b: { type: string; text?: string }) =>
      b.type === 'text' ? b.text : `[non-text ${b.type}]`).join('')
    console.log('[solpi-probe] post-execute saw text (first 200 chars):', JSON.stringify(text.slice(0, 200)))

    // P3: archive BEFORE appending anything, so the spill artifact holds the
    // exact model-facing bytes the model would have seen unmodified.
    let archiveLine = ''
    try {
      const sessionId: string | undefined = (exec as { agent?: { session?: { header?: { id?: string } } } })
        ?.agent?.session?.header?.id
      const store = ctx.get('spillStore')
      if (!sessionId || !store) {
        archiveLine = `\n[solpi-probe] archive skipped (session=${sessionId ?? 'none'}, store=${store ? 'present' : 'absent'})`
        console.warn('[solpi-probe]' + archiveLine)
      } else {
        const ref = await store.saveText({
          owner: { sessionId },
          source: { kind: 'tool', toolName: exec.name, callId: exec.callId, label: 'result' },
          suggestedName: 'solpi-probe-echo.txt',
          content: text,
        })
        console.log('[solpi-probe] spill saved:',
          JSON.stringify({ locator: ref.locator, bytes: ref.bytes, hint: ref.retrievalHint }))
        archiveLine = `\n[solpi-probe] full copy archived: ${ref.locator} (${ref.bytes} bytes)${ref.retrievalHint ? ` | hint: ${ref.retrievalHint}` : ''}`
      }
    } catch (error) {
      console.warn('[solpi-probe] saveText failed (continuing with marker only):', String(error))
      archiveLine = `\n[solpi-probe] archive failed: ${String(error)}`
    }

    // P2: append marker AFTER archive so the archived copy is the pristine text.
    const replacedText = `${text}\n[solpi-probe] post-execute intercepted ${exec.name} callId=${exec.callId}${archiveLine}`
    console.log('[solpi-probe] returning accept with replacement length',
      Buffer.byteLength(replacedText, 'utf8'))
    return {
      kind: 'accept',
      content: [{ type: 'text', text: replacedText }],
      ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}),
    }
  }, { prepend: true })

  console.log('[solpi-probe] tools/post-execute prepend listener installed')
}
