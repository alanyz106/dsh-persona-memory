/**
 * Smoke test runner — runs every suite in `test/suites/` against `dist/`.
 *
 * Kept as the single entry point so CI and the release workflow stay unchanged:
 *
 *   npm run build && node test/smoke.mjs
 *
 * Suites share ONE throwaway temp tree and one pass/fail counter (see
 * `test/harness.mjs`), and run in filename order because a few later suites
 * reuse fixtures created by earlier ones (`shared.store`, `shared.projRoot`,
 * `shared.backupMemDir`). Never touches the real Pi / `.dsh` files.
 */
import { cleanup, results } from './harness.mjs';

const suites = [
  '01-store.mjs',
  '02-scanner-standing.mjs',
  '04-project-memory.mjs',
  '05-migration-planner.mjs',
  '07-fts-cjk.mjs',
  '08-tools-guide.mjs',
  '09-store-semantics.mjs',
  '10-retrieval-sessions.mjs',
  '11-backup.mjs',
  '12-admin-routes.mjs',
  '13-migration-e2e.mjs',
  '14-plugin-lifecycle.mjs',
  '15-learning.mjs',
  '17-project-archive.mjs',
];

for (const suite of suites) {
  console.log(`\n--- ${suite} ---`);
  await import(`./suites/${suite}`);
}

cleanup();
console.log(results.failures === 0 ? '\nALL PASS' : `\n${results.failures} FAILURES`);
process.exit(results.failures === 0 ? 0 : 1);
