/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Fused mutation + follow-up command, ported from solpi-ext action-fusion/then-run.ts.
 * pi-side差异：命令执行体从 pi 的 bash 工具改为 dsh 的 `ctx.shell` 服务（resolve→run），
 * 沙箱/凭据清洗/timeout 语义由 dsh 执行器统一负责；then_run 命令失败不抛错（dsh 结果
 * 信封以 value.thenRun.status + 渲染标记表达），编辑成功永不掩盖。
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

export const THEN_RUN_SUCCEEDED = '[then_run:succeeded]'
export const THEN_RUN_FAILED = '[then_run:failed]'
export const THEN_RUN_SKIPPED = '[then_run:skipped]'

/** Model-facing fused parameter shape (schema fields defined in the tool definitions). */
export interface ThenRunInput {
  command: string
  timeout?: number
}

/** Outcome of the fused then_run leg, carried in the tool result value. */
export interface ThenRunOutcome {
  status: 'succeeded' | 'failed' | 'skipped'
  /** Command stdout+stderr (tail), or the skip/failure diagnostic. */
  output?: string
  exitCode?: number | null
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function fileSha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/**
 * Interference guard (verbatim semantics from solpi-ext): hash the target,
 * yield one macrotask so an in-flight concurrent mutation can land, hash again.
 * A mismatch skips the command instead of validating against moved ground.
 */
export async function assertUnchangedBeforeCommand(
  path: string,
  yieldForInterference: () => Promise<void> = () => new Promise<void>((resolve) => setImmediate(resolve)),
): Promise<void> {
  try {
    const mutationHash = await fileSha256(path)
    await yieldForInterference()
    const commandHash = await fileSha256(path)
    if (mutationHash !== commandHash) {
      throw new Error('target content changed after the fused mutation')
    }
  } catch (error) {
    throw new Error(`${THEN_RUN_SKIPPED} ${errorText(error)}; the command was not run.`)
  }
}

/**
 * Run the then_command via ctx.shell and classify its outcome. Never throws for
 * command-level failure — callers receive a ThenRunOutcome to merge into their value.
 */
export async function runThenCommand(
  shell: ShellLike,
  thenRun: ThenRunInput,
  workdir: string | undefined,
  signal: AbortSignal | undefined,
): Promise<ThenRunOutcome> {
  const spec = shell.resolve({
    command: thenRun.command,
    ...(workdir !== undefined ? { workdir } : {}),
    ...(thenRun.timeout !== undefined ? { timeoutMs: Math.max(1, Math.round(thenRun.timeout * 1000)) } : {}),
    ...(signal !== undefined ? { signal } : {}),
  })
  const result = await shell.run(spec)

  if (result.timedOut || result.aborted) {
    return {
      status: 'failed',
      output: result.timedOut ? 'command timed out and was killed.' : 'command aborted.',
      exitCode: result.exitCode,
    }
  }

  const parts: string[] = []
  if (result.stdout.text.length > 0) parts.push(result.stdout.text.trimEnd())
  if (result.stderr.text.length > 0) parts.push(`[stderr]\n${result.stderr.text.trimEnd()}`)
  let output = parts.join('\n')
  if (result.stdout.truncated || result.stderr.truncated) {
    output += '\n(output truncated by the executor)'
  }
  if (output.length === 0) output = '(no output)'

  return {
    status: result.exitCode === 0 && result.signal === null ? 'succeeded' : 'failed',
    output,
    exitCode: result.exitCode,
  }
}

/**
 * Minimal structural view of dsh's ShellExecutor service (avoids importing the
 * dsh-shell types package into this port).
 */
export interface ShellLike {
  resolve(request: {
    command: string
    workdir?: string
    timeoutMs?: number
    signal?: AbortSignal
    stdoutMaxBytes?: number
  }): unknown
  run(spec: never): Promise<{
    exitCode: number | null
    signal: string | null
    timedOut: boolean
    aborted: boolean
    stdout: { text: string; truncated: boolean }
    stderr: { text: string; truncated: boolean }
  }>
}
