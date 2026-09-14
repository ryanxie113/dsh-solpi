/**
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES.
 * SPDX-License-Identifier: MIT
 *
 * Dependency anchoring for out-of-tree loading (spec §9.2, official-grade).
 *
 * Bare `@deepseek-ai/*` imports cannot resolve from outside the dsh tree, so
 * every internal dependency is reached through anchors discovered here.
 * This module is deliberately FULLY SYNCHRONOUS: the dsh entry loader
 * transpiles plugins in CJS output format where top-level await is illegal
 * (2026-09-13 boot failure: "Top-level await is currently not supported with
 * the \"cjs\" output format").
 *
 * Discovery order for the running dsh installation root:
 *  1. `SOLPI_DSH_ROOT` environment variable (explicit escape hatch)
 *  2. Walk up from this file's directory probing a monorepo checkout
 *     (`packages/compaction/compaction-basic/src/region.ts` present)
 *  3. Walk up probing an installed layout (`node_modules/@deepseek-ai/*`)
 * Fail-fast on miss (plugin load error) rather than silent misroute.
 */
import { accessSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_DIR_MAP: Readonly<Record<string, readonly string[]>> = {
	// monorepo-relative workspace locations of the packages we reach into
	'@deepseek-ai/dsh-home-paths': ['packages', 'util', 'home-paths'],
	'@deepseek-ai/dsh-compaction-basic': ['packages', 'compaction', 'compaction-basic'],
	'@deepseek-ai/dsh-core-tools': ['packages', 'core', 'tools'],
}

const REGION_REL = join('packages', 'compaction', 'compaction-basic', 'src', 'region.ts')

let cachedRoot: string | null = null

function existsSync(p: string): boolean {
	try {
		accessSync(p)
		return true
	} catch {
		return false
	}
}

/** Directory of this module — survives both native ESM runs and the CJS
 * transpilation applied by the dsh entry loader (esbuild shims __dirname;
 * native ESM has import.meta.url instead). */
function selfDir(): string {
	if (typeof __dirname !== 'undefined') return __dirname
	return dirname(fileURLToPath(import.meta.url))
}

function looksLikeMonorepo(dir: string): boolean {
	return existsSync(join(dir, REGION_REL))
		&& existsSync(join(dir, ...PKG_DIR_MAP['@deepseek-ai/dsh-home-paths']!, 'package.json'))
}

function looksLikeInstalled(dir: string): boolean {
	for (const name of Object.keys(PKG_DIR_MAP)) {
		if (existsSync(join(dir, 'node_modules', name, 'package.json'))) return true
	}
	return false
}

/**
 * Root of the running dsh installation (the tree that owns
 * `packages/…` sources or `node_modules/@deepseek-ai/*`). Synchronous; result
 * cached after first success.
 */
export function harnessRoot(): string {
	if (cachedRoot !== null) return cachedRoot
	const envRoot = process.env.SOLPI_DSH_ROOT
	if (envRoot && existsSync(envRoot)) {
		cachedRoot = envRoot
		return envRoot
	}
	let dir = selfDir()
	for (;;) {
		const parent = dirname(dir)
		if (parent === dir) break
		dir = parent
		if (looksLikeMonorepo(dir)) {
			cachedRoot = dir
			return dir
		}
		if (looksLikeInstalled(dir)) {
			cachedRoot = dir
			return dir
		}
	}
	throw new Error(
		'[solpi-dsh] 无法定位 dsh 安装根目录（尝试了 SOLPI_DSH_ROOT 环境变量与从插件位置逐级向上探测 monorepo/node_modules 两种布局）。'
			+ '请设置 SOLPI_DSH_ROOT=<dsh 安装根目录> 后重启。',
	)
}

/**
 * A require function anchored inside the running dsh installation, able to
 * resolve `@deepseek-ai/*` internals regardless of layout. Synchronous.
 */
export function dshRequire(pkgName: string): NodeRequire {
	const rel = PKG_DIR_MAP[pkgName]
	if (rel === undefined) throw new Error(`[solpi-dsh] 未注册的内部包锚点: ${pkgName}`)
	const root = harnessRoot()
	const monorepoPkg = join(root, ...rel, 'package.json')
	if (existsSync(monorepoPkg)) return createRequire(monorepoPkg)
	// installed layout: node_modules lookup from the install root
	return createRequire(join(root, 'package.json'))
}

/** File URL of compaction-basic's region implementation for dynamic import. */
export function regionModuleUrl(): string {
	const p = join(harnessRoot(), REGION_REL)
	if (!existsSync(p)) throw new Error(`[solpi-dsh] region 实现不存在: ${p}`)
	return `file://${p}`
}

/**
 * `$DSH_HOME/sol-pi/…` storage root (spec §5.1). Prefers `$DSH_HOME`
 * directly; falls back to the official home-paths helper when the env var is
 * unset so state keeps working in layouts that configure DSH elsewhere.
 */
export function solPiDir(...segments: readonly string[]): string {
	const envHome = process.env.DSH_HOME
	if (envHome) return join(envHome, 'sol-pi', ...segments)
	const { dshHomePath } = dshRequire('@deepseek-ai/dsh-home-paths')('@deepseek-ai/dsh-home-paths') as {
		dshHomePath: (...segments: string[]) => string
	}
	return join(dshHomePath('sol-pi'), ...segments)
}
