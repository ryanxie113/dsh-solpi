/**
 * SoL-Pi Phase D0 spike — two load-bearing answers before EPR implementation:
 *
 *   S1  Out-of-tree Config declaration: does the loader/cordis validate a
 *       `Config` schemastery export from an absolute-path .ts entry, passing
 *       parsed (defaulted) config into apply(ctx, config)?
 *   S2  One-shot reducer-style model call via ctx.llm.stream with `system` +
 *       single user message, provider route 'qwen-proxy' — aggregates text?
 *
 * Boot evidence: '[d0] apply config.probeMark=…' line + tool output containing
 * the aggregated reply.
 */
import { createRequire } from 'node:module'

const DSH_ANCHOR = '<DSH_INSTALL_ROOT>/packages/core/tools/package.json'

const req = createRequire(DSH_ANCHOR)
const z = req('@deepseek-ai/schemastery').default ?? req('@deepseek-ai/schemastery')

export const name = 'solpi-d0-spike'

export const inject = ['tools', 'llm']

/** S1: declared via schemastery like dsh-native plugins do. */
export const Config = (z as any).object({
  probeMark: (z as any).string().default('DEFAULT-WAS-USED'),
})

interface LlmLike {
  stream(options: {
    provider: string
    model: string
    system?: string
    messages: Array<{ role: string, content: Array<{ type: string, text: string }> }>
    maxTokens?: number
  }): AsyncIterable<{ type: string, text?: string, reason?: string }>
}

export function apply(ctx: { tools: { register: (t: unknown) => void }, llm: LlmLike }, config?: { probeMark?: string }): void {
  console.log(`[d0] apply entered; config=${JSON.stringify(config)} probeMark=${config?.probeMark}`)

  const defineTool = (req('@deepseek-ai/dsh-tools') as { defineTool: unknown }).defineTool as
    (def: Record<string, unknown>) => unknown

  ctx.tools.register(defineTool({
    name: 'd0_llm_probe',
    description: 'One-shot ctx.llm.stream smoke call; returns aggregated text and finish reason.',
    parameters: {
      question: { type: 'string', required: true, description: 'What to ask the auxiliary model' },
    },
    output: {
      schema: { type: 'string' },
      render: (_a: unknown, value: string) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { question: string }) {
      let text = ''
      let reason = '<none>'
      for await (const chunk of ctx.llm.stream({
        provider: 'qwen-proxy',
        model: 'GLM-5.3-Flash',
        system: 'Answer in exactly five words.',
        messages: [
          { role: 'user', content: [{ type: 'text', text: args.question }] },
        ],
        maxTokens: 512,
      })) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        if (chunk.type === 'finish') reason = String(chunk.reason)
      }
      return JSON.stringify({ ok: true, aggregatedChars: text.length, replyText: text, finishReason: reason })
    },
  }))
  console.log('[d0] tool d0_llm_probe registered')
}
