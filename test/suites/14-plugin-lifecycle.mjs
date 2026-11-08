/**
 * Suite 14 — plugin lifecycle and the injected project block:
 *   - admin routes are effect-scoped (hot reload must not duplicate routes),
 *   - a repository with NO memory gets the bootstrap hint; one WITH memory gets
 *     the core convention — and never claims where AGENTS.md was injected.
 */
import fs from 'node:fs';
import path from 'node:path';
import { apply } from '../../dist/index.js';
import { listRegistered } from '../../dist/lib/project-registry.js';
import { check, shared, testDir } from '../harness.mjs';

// 27. admin routes are effect-scoped: a hot reload must not hit
// `webserver: duplicate exact route`. The host's webServer.register throws on a
// duplicate (kind, path) and, unlike ctx.tools.register, does NOT bind itself to
// the current fiber — so the plugin must wrap the whole family in one
// ctx.effect. Regression: 2026-10-28, the profile's HMR reload after a
// remove+add left 19 routes behind, the second apply() threw on the first route,
// the new fiber went FAILED while the stale routes kept serving.
{
  const noop = () => () => {};
  const makeCtx = (state) => ({
    logger: { info: noop(), warn: noop(), error: noop() },
    // the timer service is optional; returning undefined exercises the
    // setInterval fallback without leaving a live timer behind
    get: (key) => (key === 'timer' ? { interval: () => () => {} } : undefined),
    on: () => noop(),
    effect(body) { state.effects.push(body()); return noop(); },
    tools: { register: noop },
    commands: { register: noop },
    systemPrompt: { variable: noop, section: noop },
    webServer: {
      register(route) {
        if (state.routes.has(route.path)) {
          throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
        }
        state.routes.set(route.path, route);
        return () => state.routes.delete(route.path);
      },
    },
  });
  const pluginCfg = {
    dir: shared.backupMemDir, autoBackupMin: 0, inject: false, projectEnabled: false,
    standingEnabled: false, learnEnabled: false, vectorEnabled: false,
    memoryFtsEnabled: false,
    // `adminProfile` must NOT name a real profile: `startAutoProtect` re-reads
    // that profile's cordis.patch.yml and its `autoBackupMin` OVERRIDES the
    // `autoBackupMin: 0` above. With a real profile the very first tick backed
    // the smoke fixture up into the LIVE ~/.dsh/memory-backup/ (it clobbered
    // latest/MEMORY.md). A profile that does not exist makes the patch read
    // fail => cfg values win => no backup.
    adminProfile: 'smoke-test-no-such-profile',
    // belt and braces: even if a tick did fire, it lands in the temp dir
    backupDir: path.join(testDir, 'autoprotect-backups'),
  };
  const state = { routes: new Map(), effects: [] };
  apply(makeCtx(state), pluginCfg);
  const firstMount = state.routes.size;
  check('admin routes register on the first mount', firstMount > 0, `routes=${firstMount}`);
  // what cordis does on unload: run the effect disposers in reverse order
  for (const dispose of state.effects.reverse()) if (typeof dispose === 'function') dispose();
  check('unloading the plugin removes every admin route', state.routes.size === 0,
    `left=${state.routes.size} of ${firstMount}`);
  let remountError = null;
  const second = { routes: state.routes, effects: [] };
  try { apply(makeCtx(second), pluginCfg); } catch (e) { remountError = e; }
  check('a reload remounts without a duplicate-route error',
    remountError === null, remountError === null ? '' : String(remountError.message));
  check('the reloaded plugin serves the same route count', second.routes.size === firstMount,
    `routes=${second.routes.size}`);
  for (const dispose of second.effects.reverse()) if (typeof dispose === 'function') dispose();
}

// 28. the injected project block: a repository with no memory gets the
// bootstrap hint (previously the section was empty, so a fresh repo never
// learned this protocol existed), and one WITH memory gets the core rules.
{
  const noop = () => () => {};
  const vars = {};
  const makeCtx = () => ({
    logger: { info: noop(), warn: noop(), error: noop() },
    get: () => undefined,
    on: () => noop(),
    effect(body) { body(); return noop(); },
    tools: { register: noop },
    commands: { register: noop },
    systemPrompt: { variable: (name, fn) => { vars[name] = fn; }, section: noop },
  });
  const render = (cwd) => vars.project_block({ agent: { session: { header: { cwd } } } });

  const bootRoot = fs.mkdtempSync(path.join(testDir, 'boot-'));
  fs.mkdirSync(path.join(bootRoot, '.git'));
  const bootRegistry = fs.mkdtempSync(path.join(testDir, 'bootreg-'));
  apply(makeCtx(), {
    dir: bootRegistry, autoBackupMin: 0, standingEnabled: false, learnEnabled: false,
    vectorEnabled: false, memoryFtsEnabled: false, projectEnabled: true,
    // Same trap as the lifecycle test: `startAutoProtect` re-reads the profile
    // patch of `adminProfile` and lets its `autoBackupMin` override the 0 above.
    // A non-existent profile + a temp backupDir keeps it hermetic.
    adminProfile: 'smoke-test-no-such-profile',
    backupDir: path.join(testDir, 'autoprotect-backups'),
  });
  const emptyBlock = render(bootRoot);
  check('an empty git repo gets the bootstrap hint', /还没有项目记忆/.test(emptyBlock), emptyBlock.slice(0, 80));
  check('the bootstrap hint names the two zones', /常驻区/.test(emptyBlock) && /@memory\//.test(emptyBlock));
  check('bootstrapping does not register the project', listRegistered(bootRegistry).length === 0);
  check('a plain directory gets no project block', render(path.join(testDir, 'norepo-does-not-exist')) === '');

  // now give it memory: the bootstrap hint is replaced by the core rules
  fs.writeFileSync(path.join(bootRoot, 'AGENTS.md'), '- 构建：npm run build\n\n@memory/build.md — 构建\n');
  const filledBlock = render(bootRoot);
  check('a project with memory gets the resident/index convention', /长期记忆在 `AGENTS\.md`/.test(filledBlock), filledBlock.slice(0, 80));
  // The block must not claim where agent-instructions put AGENTS.md: on the
  // first request its baseline is appended as a user message, i.e. below this
  // prompt, so any "above" wording is wrong on turn 1.
  check('the convention makes no claim about where AGENTS.md was injected', !/上方/.test(filledBlock), filledBlock.slice(0, 80));
  check('the filled block carries the authoring essentials', /常驻区/.test(filledBlock) && /project_memory guide/.test(filledBlock));
  check('the filled block no longer bootstraps', !/还没有项目记忆/.test(filledBlock));
  check('reading a populated project registers it', listRegistered(bootRegistry).length === 1);
}
