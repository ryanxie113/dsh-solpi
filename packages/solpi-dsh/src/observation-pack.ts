/**
 * SoL-Pi ObservationPack for DeepSeek Harness @ commit c291e7961a51 — THIN
 * composition entry (user decision "B", C3).
 *
 * Architecture finding recorded for spec §9 / wiki: dsh ALREADY ships an
 * OP-isomorphic mechanism natively — `@deepseek-ai/dsh-spill-policy`
 * (packages/spill/spill-policy/src/index.ts), mounted in the default headless
 * tree alongside the `spill-local` store. It implements every mitigation the
 * C1 判别三问 review listed for OP (o1–o5):
 *
 *   o1  size gate          — flat-text byte threshold (native Config zod)
 *   o2  archive            — full original text via ctx.spillStore.saveText
 *   o3  preview            — TextRetainer head/tail window + locator/retrievalHint
 *   o4  loop prevention    — skips `read`-class results entirely
 *   o5  fail-open          — backend/save failure keeps the pristine content
 *
 * Reinventing that pipeline out-of-tree would duplicate the harness and make
 * the double-harness comparison measure OUR copy instead of the platform.
 * This entry therefore owns only the parts that are genuinely ours:
 *
 *   1. Composition visibility — validates/logs the composed contract at boot
 *      (`[solpi-dsh/op] …`) so every acceptance run leaves the intended
 *      settings in the transcript, not just in --dump-config.
 *
 *   2. The Evidence-Preserving Reducer seam (reserved for Phase D) — a
 *      `tools/post-execute` PREPEND listener registered AFTER spill-policy's
 *      row in tree order. Because it is inserted later AND prepended, it sits
 *      in front of spill-policy's listener in the waterfall; it MUST delegate
 *      via next(). Today it is an honest pass-through placeholder whose job is
 *      to fix the interception point where Phase D will exempt
 *      `sol-pi-evidence-receipt/1` receipt results from being spilled away.
 *
 * Configuration contract: thresholds stay owned by the stock row's real Config
 * schema (overlay sets spill-policy.config.maxInlineBytes); the config passed
 * to THIS entry mirrors that value purely so the composed pair is verifiable
 * from one place. No env reads, no hardcoded credentials, no duplicated store.
 */

export const name = 'solpi-dsh-op'

export const inject = ['tools']

/** Mirrors the overlay's spill-policy.config for one-line compose verification. */
interface OpConfig {
  /** Expected effective spill threshold configured on the stock row. */
  maxInlineBytes?: number
}

/** Receipt discriminator shared with the Phase-D reducer port (receipts open with this line). */
export const EPR_RECEIPT_PREFIX = 'sol_pi_evidence_receipt_v1'

export function apply(ctx: {
  on: (event: string, listener: (...args: unknown[]) => unknown, opts?: { prepend?: boolean }) => unknown
}, config?: OpConfig): void {
  const expected = typeof config?.maxInlineBytes === 'number' ? config.maxInlineBytes : undefined
  console.log(`[solpi-dsh/op] composed over native @deepseek-ai/dsh-spill-policy (expected maxInlineBytes=${expected ?? '<unset>'}); EPR receipt-exemption hook armed (Phase D)`)

  /**
   * Phase-D seam. Waterfall discipline: always `next()` unless a future
   * revision decides FOR THIS RESULT to bypass downstream transformers by
   * returning its own decision instead. Ordering guarantee: this plugin loads
   * after the stock spill-policy row and uses prepend, so this handler runs
   * before spill-policy's — a later return here can shield a receipt.
   */
  ;(ctx as unknown as {
    on: (
      event: 'tools/post-execute',
      listener: (exec: unknown, result: Readonly<{ content?: Array<{ type: string; text?: string }> }>, next: () => Promise<unknown>) => Promise<unknown>,
      opts?: { prepend?: boolean },
    ) => unknown
  }).on(
    'tools/post-execute',
    async (_exec, result, next) => {
      // Phase-D activation: a result whose text starts with the receipt prefix
      // leaves through an EARLY accept (no `next()`), so downstream
      // transformers — notably spill-policy — never re-pack an already-verified
      // receipt. Ordering guarantee: this entry registers after spill-policy's
      // row and prepends, so this handler runs first in the waterfall.
      const blocks = (result?.content ?? []).filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
      if (blocks.some((b) => b.text.startsWith(EPR_RECEIPT_PREFIX))) {
        console.log('[solpi-dsh/op] EPR receipt exempted from downstream packing')
        return { kind: 'accept' as const }
      }
      return await next()
    },
    { prepend: true },
  )
}
