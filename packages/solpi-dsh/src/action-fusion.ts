/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Action Fusion on dsh — replace stock edit/write with fused variants taking an
 * optional `then_run` follow-up command, so "mutate + verify" costs one model turn.
 *
 * Composition contract (overlay): the stock `@deepseek-ai/dsh-tool-fs` row is
 * DISABLED and this plugin re-registers read/read_image unchanged plus fused
 * write/edit. All heavy semantics (parse/format/diff/remediation/sandbox/
 * session-cwd/read windows) are REUSED from dsh-tool-fs sources via dynamic
 * import of their src modules — this file owns only the fusion wrapper.
 *
 * Out-of-tree loading constraint (Phase B finding): bare `@deepseek-ai/*` ESM
 * imports cannot resolve from outside the harness tree, so every dependency is
 * awaited through absolute-file-URL dynamic imports inside async apply().
 */
import { pathToFileURL } from 'node:url'

import { dshRequire, harnessRoot } from './anchors.ts'
import { logEvent } from './telemetry.ts'

/** Resolve a dsh-internal relative source path against the discovered install root. */
async function imp(rel: string): Promise<Record<string, unknown>> {
  return await import(pathToFileURL(`${harnessRoot()}/packages/${rel}`)) as Record<string, unknown>
}

export const name = 'solpi-dsh-action-fusion'

/** Same service set as dsh-tool-fs plus shell (fused then_run executor). */
export const inject = ['tools', 'fs', 'systemPrompt', 'shell']

const EDIT_THEN_RUN_DESCRIPTION =
  'Verification or follow-up command executed in the SAME tool call as this edit — one round trip instead of two. When the task requires running tests/build/checks after modifying code, ALWAYS put that command here instead of issuing a separate bash call afterwards. Skipped if the edit fails; a non-zero exit is reported but keeps the edit.'
const WRITE_THEN_RUN_DESCRIPTION =
  'Verification or follow-up command executed in the SAME tool call as this write — one round trip instead of two. When the task requires running tests/build/checks after creating files, ALWAYS put that command here instead of issuing a separate bash call afterwards. Skipped if the write fails; a non-zero exit is reported but keeps the write.'

interface ThenRunSchemaValue {
  command?: string
  timeout?: number
}

export async function apply(ctx: ContextLike): Promise<void> {
  // ---- reused seams -------------------------------------------------------
  const [toolsMod, writeMod, editMod, diffMod, errorMod, cwdMod, sandboxMod] = await Promise.all([
    imp('core/tools/lib/index.js'),
    imp('fs/tool-fs/src/write.ts'),
    imp('fs/tool-fs/src/edit.ts'),
    imp('fs/tool-fs/src/diff.ts'),
    imp('fs/tool-fs/src/error.ts'),
    imp('fs/tool-fs/src/session-cwd.ts'),
    imp('fs/tool-fs/src/sandbox.ts'),
  ])
  const readMod = await imp('fs/tool-fs/src/read.ts')
  const renderMod = await imp('fs/tool-fs/src/read-render.ts')
  const imageMod = await imp('fs/tool-fs/src/read-image.ts')

  const defineTool = toolsMod.defineTool as DefineToolFn
  const parseWriteArgs = writeMod.parseWriteArgs as typeof importWriteParse
  const formatWriteOutput = writeMod.formatWriteOutput as (displayPath: string, outcome: { operation: string }) => string
  const parseEditArgs = editMod.parseEditArgs as typeof importEditParse
  const formatEditOutput = editMod.formatEditOutput as (displayPath: string, replaceAll: boolean) => string
  const computeHunkDiffs = diffMod.computeHunkDiffs as DiffComputeFn
  const diffsFromMeta = diffMod.diffsFromMeta as DiffFromMetaFn
  const remediateFsError = errorMod.remediateFsError as RemEDIATEfn
  const sessionResolveOptions = cwdMod.sessionResolveOptions as SessionResolveFn
  const FsSandboxController = sandboxMod.FsSandboxController as new (ctx: ContextLike) => SandboxControllerLike
  const applyReadTool = readMod.applyReadTool as ApplyReadFn
  const READ_LIMIT = readMod.READ_LIMIT as number
  const STREAM_MIN_SIZE = readMod.STREAM_MIN_SIZE as number
  const READ_MAX_BYTES = renderMod.READ_MAX_BYTES as number
  const READ_MAX_LINE_LENGTH = renderMod.READ_MAX_LINE_LENGTH as number
  const applyReadImageTool = imageMod.applyReadImageTool as ApplyReadImageFn

  // ---- stock read suite (unchanged behavior) ------------------------------
  applyReadTool(ctx as never, {
    limit: READ_LIMIT,
    maxLineLength: READ_MAX_LINE_LENGTH,
    maxBytes: READ_MAX_BYTES,
    streamMinSize: STREAM_MIN_SIZE,
  })
  ;(ctx as unknown as { inject?: (services: string[], fn: (c: ContextLike) => void) => void }).inject?.(['attachments'], (imageCtx) => {
    applyReadImageTool(imageCtx as never)
  })

  const sandbox = new FsSandboxController(ctx)

  // ---- shared fusion helpers ---------------------------------------------
  const queueMod = await import('./file-queue.ts')
  const thenRunMod = await import('./then-run.ts')
  const resolveToolPath = queueMod.resolveToolPath as (cwd: string | undefined, p: string) => string
  const withFusedFileQueue = queueMod.withFusedFileQueue as <T>(p: string, w: () => Promise<T>) => Promise<T>
  const assertUnchangedBeforeCommand = thenRunMod.assertUnchangedBeforeCommand as AssertUnchangedFn
  const runThenCommand = thenRunMod.runThenCommand as RunThenCommandFn

  /** Pure renderer for then_run terminal markers (emission lives in the pipeline). */
  function markerFor(status: string): string {
    return status === 'succeeded' ? thenRunMod.THEN_RUN_SUCCEEDED as string : thenRunMod.THEN_RUN_FAILED as string
  }

  /** Append the then_run suffix lines to the base model-facing text. */
  function withThenRunSuffix(baseText: string, value: { thenRun?: { status: string, output?: string } | undefined, afCoach?: string }): TextBlock[] {
    const t = value.thenRun
    if (t === undefined) {
      return [{ type: 'text', text: value.afCoach === undefined ? baseText : `${baseText}\n\n${value.afCoach}` }]
    }
    const lines = [baseText, '', markerFor(t.status)]
    if (t.output !== undefined && t.output.length > 0) lines.push(t.output)
    return [{ type: 'text', text: lines.join('\n') }]
  }

  const thenRunSchemaField = {
    type: 'object',
    additionalProperties: false,
    description: '',
    properties: {
      command: { type: 'string', required: true, description: 'Bash command to run' },
      timeout: { type: 'number', description: 'Timeout in seconds (optional, no default timeout)' },
    },
  } as const

  const thenRunOutputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', required: true, enum: ['succeeded', 'failed'] },
      output: { type: 'string' },
      exitCode: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    },
  } as const

  const escalationFields = (): Record<string, unknown> =>
    sandbox.escalationModes.length > 0 ? sandbox.schemaFields() as Record<string, unknown> : {}

  /**
   * Fused mutation pipeline (mirrors solpi-ext executeMutationThenRun):
   * mutate → (failure && then_run ⇒ skipped-marker error) → no then_run ⇒ plain
   * result → interference guard → ctx.shell run → merge ThenRunOutcome into value.
   */
  async function fusedExecute(
    kind: 'write' | 'edit',
    mutateArgs: Record<string, unknown>,
    thenRun: ThenRunSchemaValue | undefined,
    exec: ExecLike,
    mutate: () => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const absPath = resolveToolPath(exec.agent?.session.header.cwd, mutateArgs.file_path as string)
    return await withFusedFileQueue(absPath, async () => {
      let value: Record<string, unknown>
      try {
        value = await mutate()
      } catch (error) {
        if (thenRun !== undefined) {
          const message = error instanceof Error ? error.message : String(error)
          void logEvent({ kind: 'af-then-run', status: 'skipped', reason: 'guard-mismatch', session: exec.agent?.session.id })
          throw new Error(`${message}\n\n${thenRunMod.THEN_RUN_SKIPPED as string} The file mutation did not complete successfully; the command was not run.`)
        }
        throw error
      }
      if (thenRun === undefined || thenRun.command === undefined || thenRun.command.trim().length === 0) {
        // Runtime coach: models (observed on GLM Flash, benchmark T2) ignore the
        // then_run schema field and fall back to a separate bash round trip.
        // A per-call nudge in the tool result shapes the behavior far better
        // than prose in the tool description alone. Always on; zero config.
        return { ...value, afCoach: AF_COACH_TEXT }
      }
      try {
        await assertUnchangedBeforeCommand(absPath)
      } catch (error) {
        // Guard trip: mutation IS durable; surface skipped marker verbatim.
        throw error instanceof Error ? error : new Error(String(error))
      }
      const outcome = await runThenCommand(
        ctx.shell as never,
        { command: thenRun.command, ...(thenRun.timeout !== undefined ? { timeout: thenRun.timeout } : {}) },
        exec.agent?.session.header.cwd,
        exec.signal,
      )
      void logEvent({ kind: 'af-then-run', status: String(outcome.status), session: exec.agent?.session.id })
      return { ...value, thenRun: outcome }
    })
  }

  // ============================ WRITE ======================================
  ctx.systemPrompt.section({
    name: 'tool:write',
    order: ctx.systemPrompt.getSectionOrder('TOOL_WRITE'),
    text: ({ scope }: { scope: unknown }) => (ctx.tools as ToolsView).get('write', scope) === undefined
      ? ''
      : 'Use the write tool to create files or completely replace file contents. Existing files are overwritten, so read an existing file first (the default fs-observation-policy requires it)'
        + ((ctx.tools as ToolsView).get('edit', scope) === undefined ? '' : ' and prefer edit for targeted changes')
        + '. Whenever you would run a test/build/check right after modifying a file, pass it as then_run in the SAME edit/write call instead of a separate bash call.'
      ,
  })

  ctx.tools.register(defineTool({
    name: 'write',
    description: 'Create or fully replace a UTF-8 text file.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to write, resolved by the filesystem backend.' },
      content: { type: 'string', required: true, description: 'Full UTF-8 text content to write.' },
      then_run: {
        ...thenRunSchemaField,
        description: WRITE_THEN_RUN_DESCRIPTION,
      },
      ...escalationFields(),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          operation: { type: 'string', required: true, enum: ['create', 'update'] },
          before: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          after: { type: 'string', required: true },
          thenRun: thenRunOutputSchema,
          afCoach: { type: 'string' },
        },
      },
      render: (_args: unknown, value: WriteValueLike) =>
        withThenRunSuffix(formatWriteOutput(value.path, value), value),
      presentationMeta: (args: { file_path: string }, value: WriteValueLike) => ({
        diffs: value.before === null
          ? []
          : (computeHunkDiffs(args.file_path, value.before, value.after) as unknown[])
            .map(({ path, oldText, newText }) => ({ path, oldText, newText })),
      }),
    },
    async execute(args: Record<string, unknown>, exec: ExecLike) {
      const { then_run, ...rest } = args as { then_run?: ThenRunSchemaValue }
      const input = parseWriteArgs(rest as never)
      const sandboxPolicy = await sandbox.resolvePolicy('write', rest, exec as never)
      const target = await ctx.fs.resolve(input.filePath, sessionResolveOptions(exec, input.filePath, sandboxPolicy?.workspaceRoot))
      let outcome: Record<string, unknown>
      try {
        const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
        outcome = await ctx.fs.writeText(target, input.content, intent, exec.signal, sandboxPolicy)
      } catch (error: unknown) {
        throw remediateFsError(sandbox.mapError(error, sandboxPolicy), (target as { displayPath: string }).displayPath)
      }
      ctx.emit('fs/observed', target, { kind: 'present', version: (outcome as { version: unknown }).version }, exec)
      // Project exactly the stock tool's value fields — FsWriteOutcome.version is
      // harness-internal and would fail the output-schema validator.
      const o = outcome as { operation: string, before: string | null, after: string }
      return await fusedExecute(
        'write', rest, then_run, exec,
        () => Promise.resolve({ path: (target as { displayPath: string }).displayPath, operation: o.operation, before: o.before, after: o.after }),
      )
    },
    presentCall(args: { file_path: string, content: string }) {
      return {
        card: 'diff',
        title: `Write ${args.file_path}`,
        diffs: [{ path: args.file_path, oldText: null, newText: args.content }],
        locations: [{ path: args.file_path }],
      }
    },
    presentResult(args: { file_path: string, content: string }, result: { isError?: boolean, meta?: unknown }) {
      if (result.isError) return undefined
      const diffs = diffsFromMeta(result.meta)
        ?? [{ path: args.file_path, oldText: null, newText: args.content }]
      return { card: 'diff', title: `Write ${args.file_path}`, diffs }
    },
  }) as never)

  // ============================ EDIT =======================================
  ctx.systemPrompt.section({
    name: 'tool:edit',
    order: ctx.systemPrompt.getSectionOrder('TOOL_EDIT'),
    text: ({ scope }: { scope: unknown }) => (ctx.tools as ToolsView).get('edit', scope) === undefined
      ? ''
      : 'Use the edit tool for targeted changes to existing UTF-8 text files. It replaces literal old_string with new_string; by default old_string must appear exactly once. If old_string appears multiple times, provide a more specific old_string or set replace_all to true. Read the file first (the default fs-observation-policy requires it), unless you just created or edited it in this session. Optionally pass then_run to verify the result with one command in the same turn.'
      ,
  })

  ctx.tools.register(defineTool({
    name: 'edit',
    description: 'Edit an existing UTF-8 text file by replacing literal text.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to edit, resolved by the filesystem backend.' },
      old_string: { type: 'string', required: true, description: 'Literal text to replace. Must match exactly.' },
      new_string: { type: 'string', required: true, description: 'Literal replacement text. Use an empty string to delete the match.' },
      replace_all: { type: 'boolean', description: 'Replace all matches. Defaults to false; when false, old_string must appear exactly once.' },
      then_run: {
        ...thenRunSchemaField,
        description: EDIT_THEN_RUN_DESCRIPTION,
      },
      ...escalationFields(),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          before: { type: 'string', required: true },
          after: { type: 'string', required: true },
          thenRun: thenRunOutputSchema,
          afCoach: { type: 'string' },
        },
      },
      render: (args: { replace_all?: boolean }, value: EditValueLike) =>
        withThenRunSuffix(formatEditOutput(value.path, args.replace_all ?? false), value),
      presentationMeta: (args: { file_path: string }, value: EditValueLike) => ({
        diffs: (computeHunkDiffs(args.file_path, value.before, value.after) as unknown[])
          .map(({ path, oldText, newText }) => ({ path, oldText, newText })),
      }),
    },
    async execute(args: Record<string, unknown>, exec: ExecLike) {
      const { then_run, ...rest } = args as { then_run?: ThenRunSchemaValue }
      const input = parseEditArgs(rest as never)
      const sandboxPolicy = await sandbox.resolvePolicy('edit', rest, exec as never)
      const target = await ctx.fs.resolve(input.filePath, sessionResolveOptions(exec, input.filePath, sandboxPolicy?.workspaceRoot))
      let outcome: Record<string, unknown>
      try {
        const intent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
        outcome = await ctx.fs.editText(
          target,
          { oldString: input.oldString, newString: input.newString, replaceAll: input.replaceAll },
          intent,
          exec.signal,
          sandboxPolicy,
        ) as unknown as Record<string, unknown>
      } catch (error: unknown) {
        throw remediateFsError(sandbox.mapError(error, sandboxPolicy), (target as { displayPath: string }).displayPath)
      }
      ctx.emit('fs/observed', target, { kind: 'present', version: (outcome as { version: unknown }).version }, exec)
      // Project exactly the stock tool's value fields (same rationale as write).
      const oe = outcome as { before: string, after: string }
      return await fusedExecute(
        'edit', rest, then_run, exec,
        () => Promise.resolve({ path: (target as { displayPath: string }).displayPath, before: oe.before, after: oe.after }),
      )
    },
    presentCall(args: { file_path: string, old_string: string, new_string: string }) {
      return {
        card: 'diff',
        title: `Edit ${args.file_path}`,
        diffs: [{ path: args.file_path, oldText: args.old_string || null, newText: args.new_string }],
        locations: [{ path: args.file_path }],
      }
    },
    presentResult(_args: unknown, result: { isError?: boolean, meta?: unknown }) {
      if (result.isError) return undefined
      const diffs = diffsFromMeta(result.meta)
      if (diffs === undefined) return undefined
      return { card: 'diff', title: 'Edit', diffs }
    },
  }) as never)

  console.log('[solpi-dsh/af] fused write/edit registered (stock tool-fs row disabled); read suite reused from dsh-tool-fs')
}

// ---------------------------------------------------------------------------
// Local structural types (avoid importing dsh packages into this port).
// ---------------------------------------------------------------------------
type ContextLike = {
  tools: ToolsView
  fs: FsLike
  systemPrompt: {
    section(spec: { name: string, order: number, text: (arg: { scope: unknown }) => string }): unknown
    getSectionOrder(name: string): number
  }
  waterfall(event: string, ...rest: unknown[]): Promise<unknown>
  emit(event: string, ...rest: unknown[]): void
  inject?(service: string, fn: (c: ContextLike) => void): void
  shell: unknown
}
type ToolsView = {
  register(def: unknown): () => void
  get(name: string, scope?: unknown): unknown
}
type FsLike = {
  resolve(path: string, options?: unknown): Promise<{ displayPath: string }>
  writeText(target: unknown, content: string, intent?: unknown, signal?: AbortSignal, policy?: unknown): Promise<Record<string, unknown>>
  editText(target: unknown, edit: unknown, intent?: unknown, signal?: AbortSignal, policy?: unknown): Promise<Record<string, unknown>>
}
type ExecLike = {
  agent?: { session?: { header?: { cwd?: string } } }
  signal: AbortSignal
}
type DefineToolFn = (definition: Record<string, unknown>) => unknown
type DiffComputeFn = (path: string, before: string, after: string) => Array<{ path: string, oldText: string | null, newText: string }>
type DiffFromMetaFn = (meta: unknown) => Array<{ path: string, oldText: string | null, newText: string }> | undefined
type RemEDIATEfn = (error: unknown, displayPath: string) => unknown
type SessionResolveFn = (exec: unknown, requestedPath: string, root?: string) => unknown
type SandboxControllerLike = {
  readonly escalationModes: readonly unknown[]
  schemaFields(): unknown
  resolvePolicy(toolName: string, args: unknown, exec: unknown): Promise<{ workspaceRoot?: string } | undefined>
  mapError(error: unknown, policy: unknown): unknown
}
type ApplyReadFn = (ctx: never, caps: { limit: number, maxLineLength: number, maxBytes: number, streamMinSize: number }) => void
type ApplyReadImageFn = (ctx: never) => void
type AssertUnchangedFn = (path: string, yieldFn?: () => Promise<void>) => Promise<void>
type RunThenCommandFn = (shell: never, thenRun: { command: string, timeout?: number }, workdir: string | undefined, signal: AbortSignal | undefined) => Promise<{
  status: 'succeeded' | 'failed'
  output?: string
  exitCode?: number | null
}>
/** Runtime coach appended to unfused mutation results (see fusedExecute). */
const AF_COACH_TEXT =
  '[af-coach] This mutation ran without then_run, so your follow-up verification needed a separate call. Next time fuse them: re-issue this same mutation and add "then_run": {"command": "<the exact test/build command you were about to run next>"}. The command executes immediately after the file lands.'

type WriteValueLike = { path: string, before: string | null, after: string, thenRun?: { status: string, output?: string } | undefined, afCoach?: string }
type EditValueLike = { path: string, before: string, after: string, thenRun?: { status: string, output?: string } | undefined, afCoach?: string }
type TextBlock = { type: 'text', text: string }
type importWriteParse = (args: { file_path: string, content: string }) => { filePath: string, content: string }
type importEditParse = (args: { file_path: string, old_string: string, new_string: string, replace_all?: boolean }) => { filePath: string, oldString: string, newString: string, replaceAll: boolean }
