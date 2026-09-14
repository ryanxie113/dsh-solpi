/**
 * Standalone bundle build for npm/GitHub distribution (publish.md §bundle).
 * Mirrors the turtle-ui pattern: transpile src/ without project references
 * or type checking — self-contained, no sibling-checkout assumptions.
 * Dev/runtime mode stays on node --experimental-strip-types against src/.
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: [
		'src/action-fusion.ts',
		'src/observation-pack.ts',
		'src/evidence-preserving-reducer.ts',
		'src/online-context-compact.ts',
	],
	outDir: 'lib',
	format: ['esm'],
	platform: 'node',
	target: 'es2024',
	dts: false,
	unbundle: false,
	clean: true,
})
