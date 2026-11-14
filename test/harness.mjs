/**
 * Shared fixtures + assertion helper for the smoke suites.
 *
 * Every suite in `test/suites/` imports from here instead of building its own
 * temp tree, so the run keeps ONE throwaway directory (removed by the runner)
 * and ONE pass/fail counter. State that genuinely spans suites (the global
 * memory store, the sample project root) lives on `shared` — everything else
 * belongs to the suite that creates it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Throwaway root for every suite; the real Pi/`.dsh` files are never touched. */
export const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-smoke-'));

const srcDir = path.join(os.homedir(), '.pi', 'agent', 'pi-hermes-memory');
/**
 * Prefer a COPY of the real shared hermes files; on CI / fresh machines seed
 * minimal hermes-format files so the format tests still run meaningfully.
 */
export const hasRealFiles = fs.existsSync(path.join(srcDir, 'MEMORY.md'))
  && fs.existsSync(path.join(srcDir, 'USER.md'));
if (hasRealFiles) {
  fs.copyFileSync(path.join(srcDir, 'MEMORY.md'), path.join(testDir, 'MEMORY.md'));
  fs.copyFileSync(path.join(srcDir, 'USER.md'), path.join(testDir, 'USER.md'));
} else {
  fs.writeFileSync(path.join(testDir, 'MEMORY.md'), 'ci-seed fact <!-- created=2026-01-01, last=2026-01-01 -->\n');
  fs.writeFileSync(path.join(testDir, 'USER.md'), 'ci-seed user profile <!-- created=2026-01-01, last=2026-01-01 -->\n');
}

/**
 * Tests exercise format/round-trip behavior, not capacity — generous limits so
 * a copied real hermes file never trips the overflow refusal mid-suite.
 */
export const BIG_LIMITS = { memory: 1_000_000, user: 1_000_000 };

/** Cross-suite fixtures (`store` from 01, `projRoot` from 05). */
export const shared = {};

/** Mutable run result, read by the runner. */
export const results = { failures: 0 };

/**
 * Record one assertion.
 * @param label what is being asserted, in plain words
 * @param cond the assertion result
 * @param extra optional detail printed after the em dash on failure
 */
export function check(label, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) results.failures++;
}

/** Remove the throwaway tree once every suite has run. */
export function cleanup() {
  fs.rmSync(testDir, { recursive: true, force: true });
}
