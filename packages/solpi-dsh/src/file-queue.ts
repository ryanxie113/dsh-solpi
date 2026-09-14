/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Per-canonical-path mutation queue, ported from solpi-ext action-fusion/file-queue.ts.
 * Serializes fused edit+then_run work for one file so another fused mutation of the
 * same canonical target cannot interleave. This queue is ours and deliberately does
 * not nest any provider-internal queue.
 */

import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'

const queueTails = new Map<string, Promise<void>>()

function stripToolPathPrefix(filePath: string): string {
  return filePath.startsWith('@') ? filePath.slice(1) : filePath
}

/** Expand `~` and resolve against `cwd` — same rules as pi's tool-path shim. */
export function resolveToolPath(cwd: string | undefined, filePath: string): string {
  const expanded = stripToolPathPrefix(filePath)
  if (expanded === '~') return homedir()
  if (expanded.startsWith('~/')) return resolve(homedir(), expanded.slice(2))
  return resolve(cwd ?? process.cwd(), expanded)
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as { code?: unknown }).code === 'ENOENT' || (error as { code?: unknown }).code === 'ENOTDIR')
  )
}

/**
 * Canonical queue key: realpath of the deepest existing ancestor joined with the
 * missing tail segments, so pre-create writes and post-create edits queue together.
 */
async function canonicalQueueKey(filePath: string): Promise<string> {
  const resolvedPath = resolve(filePath)
  let current = resolvedPath
  const missingSegments: string[] = []

  while (true) {
    try {
      return resolve(await realpath(current), ...missingSegments)
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      const parent = dirname(current)
      if (parent === current) return resolvedPath
      missingSegments.unshift(basename(current))
      current = parent
    }
  }
}

/** Serialize fused operations for one canonical file path. */
export async function withFusedFileQueue<T>(filePath: string, work: () => Promise<T>): Promise<T> {
  const key = await canonicalQueueKey(filePath)
  const previous = queueTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const owned = new Promise<void>((resolveOwned) => {
    release = resolveOwned
  })
  const tail = previous.then(() => owned)
  queueTails.set(key, tail)

  await previous
  try {
    return await work()
  } finally {
    release()
    if (queueTails.get(key) === tail) queueTails.delete(key)
  }
}
