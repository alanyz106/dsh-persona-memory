/**
 * Client UI contract tests for the "处理中" state.
 *
 * The bundle is the REAL shipped client/client.js (built by npm run build),
 * loaded through a fake window.__ModuleLoader__. React.createElement is then
 * rendered with a tiny hook-capable renderer: enough to assert that the refresh
 * button is actually DISABLED while a request is in flight and that a long
 * migration shows its real stage, without pulling in react-dom or a browser.
 *
 * Run after `npm run build`: node test/client-ui.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/**
 * `react` is a peer dependency (the dsh web host provides it at runtime), and
 * CI installs with --legacy-peer-deps, so it is NOT in node_modules there.
 * This test only renders React.createElement trees with a hook dispatcher, so
 * a tiny local shim is enough — no react-dom, no browser, no network.
 */
const dispatcherBox = { current: null };
/** Every hook delegates to whichever dispatcher the harness installed. */
const hook = (name) => (...args) => {
  const d = dispatcherBox.current;
  if (!d) throw new Error('rendered outside the test dispatcher: ' + name);
  return d[name](...args);
};
const React = {
  createElement(type, props, ...children) {
    return { type, props: Object.assign({}, props, children.length <= 1 ? { children: children[0] } : { children }), key: null, ref: null };
  },
  useState: hook('useState'),
  useEffect: hook('useEffect'),
  useCallback: hook('useCallback'),
  useRef: hook('useRef'),
  useLayoutEffect: hook('useLayoutEffect'),
  __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: dispatcherBox },
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const bundle = fs.readFileSync(path.join(root, 'client', 'client.js'), 'utf8');

let pass = 0;
let fail = 0;
function check(label, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  }
}

// ---------------------------------------------------------------- load bundle
let registered;
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      registered = { id, exports: factory((name) => {
        if (name === 'react') return React;
        throw new Error('unexpected client require: ' + name);
      }) };
    },
  },
  localStorage: { getItem: () => null, setItem: () => {} },
  setInterval: () => 1,
  clearInterval: () => {},
  navigator: { clipboard: { writeText: () => {} } },
};
// The bundle is a plain browser script (CJS factory), not an ES module.
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT', err && err.stack || err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED', err && err.stack || err);
  process.exit(1);
});
new Function('window', 'require', bundle)(globalThis.window, require);
check('client bundle registers under the package name',
  !!registered && registered.id === '@alanyz106/dsh-persona-memory', String(registered && registered.id));
const { apply } = registered.exports;
let Page;
apply({
  slots: {
    inject: (_slot, factory) => factory(),
    register: (_opts, component) => { Page = component; return () => {}; },
  },
});
check('page registers into the settings.section slot', typeof Page === 'function');

// ------------------------------------------------------- minimal hook renderer
/**
 * Executes one functional component render and COLLECTS its effects. Hooks are
 * stored by call order — exactly React's rule for one component. The test calls
 * the collected effects explicitly so the async load/migrate flows can be
 * stepped without react-dom or a browser event loop driving them.
 */
function renderOnce(Component, hookState, seed = {}) {
  const effects = [];
  let index = 0;
  const dispatcher = {
    useState(initial) {
      const i = index++;
      if (!(i in hookState)) {
        hookState[i] = i in seed ? seed[i] : (typeof initial === 'function' ? initial() : initial);
      }
      return [hookState[i], (next) => { hookState[i] = typeof next === 'function' ? next(hookState[i]) : next; }];
    },
    useRef(initial) {
      const i = index++;
      if (!(i in hookState)) hookState[i] = { current: initial };
      return hookState[i];
    },
    useEffect(fn, deps) {
      const i = index++;
      const prev = hookState[i];
      hookState[i] = { deps };
      if (!prev || !deps || !prev.deps || prev.deps.length !== deps.length
        || deps.some((d, j) => d !== prev.deps[j])) effects.push({ fn, deps });
    },
    useLayoutEffect(fn, deps) {
      index++;
      effects.push({ fn, deps });
    },
    useCallback(fn, deps) {
      const i = index++;
      const prev = hookState[i];
      const same = prev && prev.deps && deps
        && prev.deps.length === deps.length && deps.every((d, j) => d === prev.deps[j]);
      // React keeps the callback identity while deps are unchanged. Without
      // this, the mount-load effect would re-fire on every render and its
      // /status payload would overwrite an in-flight migration's real stage.
      hookState[i] = same ? prev : { fn, deps };
      return hookState[i].fn;
    },
  };
  const previous = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current;
  React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current = dispatcher;
  try {
    return { tree: Component({}), effects };
  } finally {
    React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current = previous;
  }
}

/** Flat element iterator (React.createElement trees only). */
function* walk(node) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  yield node;
  if (node.props && node.props.children !== undefined) yield* walk(node.props.children);
}
function elements(tree) { return [...walk(tree)]; }
function buttons(tree) { return elements(tree).filter((n) => n.type === 'button'); }
function findButton(tree, label) {
  return buttons(tree).find((b) => elements(b).some((n) => typeof n.props.children === 'string' && n.props.children === label));
}
function visibleText(tree) {
  return elements(tree)
    .filter((n) => typeof n.type === 'string' && typeof n.props.children === 'string')
    .map((n) => n.props.children).join(' ');
}

const STATUS = {
  dir: '/tmp/memory', which: 'dsh-only',
  config: { projectMigrateTimeoutMs: 600000 }, schema: [], backupDir: '/tmp/backup',
  backups: [], stores: {}, standing: { instructions: [], chars: 0 },
  indexes: {}, models: { dir: '', models: [] }, projects: [], entries: {},
  llmRouteAvailable: true, llmRoute: { provider: '9router', model: 'cbcn/hy4free' },
  migration: { active: false }, ts: Date.now(),
};
const WITH_PROJECT = {
  ...STATUS,
  projects: [{
    name: 'demo', root: '/tmp/demo', exists: true,
    resident: ['# 规则'], residentChars: 10, residentLimit: 3000,
    indexChars: 0, indexLimit: 4000, entries: [], orphans: [],
  }],
};

/** Drive one async fetch queue. Unresolved handlers freeze a request in flight. */
function makeFetch(handlers) {
  const calls = [];
  globalThis.fetch = (url, init) => {
    const name = String(url).replace('/api/persona-memory', '').split('?')[0];
    calls.push({ name, init });
    const fn = Object.prototype.hasOwnProperty.call(handlers, name) ? handlers[name] : handlers.default;
    const value = typeof fn === 'function' ? fn() : fn;
    return Promise.resolve(value).then((body) => ({ ok: true, status: 200, json: async () => body }));
  };
  return calls;
}

/** Run all collected effects; their async continuations settle on microtasks. */
async function runEffects(effects) {
  for (const effect of effects) {
    try { await effect.fn(); } catch { /* component effects handle their own errors */ }
  }
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
}

// ------------------------------------------------------------ idle vs in-flight
const calls = makeFetch({ default: () => WITH_PROJECT });
// Persisted UI state: all six cards open + the demo project accordion open, so
// the migration button is visible on the very first settled render.
const openCards = { standing: true, files: true, indexes: true, projects: true, backups: true, config: true };
// Hook indices (verified call order in MemAdminPage): 7 = initialUi,
// 8 = projOpen, 19 = open, 23 = cfgGroupsOpen.
const seed = {
  7: { open: openCards, projOpen: 'demo', residentOpen: {}, configGroups: {} },
  8: 'demo',
  19: openCards,
  23: {},
};
const hooks = [];
const first = renderOnce(Page, hooks, seed);
check('initial render shows a loading state', /正在加载/.test(visibleText(first.tree)));
await runEffects(first.effects);
let tree = renderOnce(Page, hooks, seed).tree;
const idleRefresh = findButton(tree, '刷新');
check('idle page has an enabled 刷新 button',
  !!idleRefresh && idleRefresh.props.disabled !== true && typeof idleRefresh.props.onClick === 'function',
  JSON.stringify({ found: !!idleRefresh, disabled: idleRefresh && idleRefresh.props.disabled }));
check('boot fetched /status through the same-origin route', calls.some((c) => c.name === '/status'));
const migrateBtn = findButton(tree, '迁移旧 AGENTS.md');
check('prose project exposes a migration button', !!migrateBtn, visibleText(tree).slice(0, 250));
check('migration hint names the inherited default model and configurable timeout',
  /使用 9router\/cbcn\/hy4free/.test(visibleText(tree)) && /规划超时 10 分钟/.test(visibleText(tree)),
  visibleText(tree).slice(-350));
check('migration tooltip names the route and timeout',
  !!migrateBtn && /9router\/cbcn\/hy4free/.test(String(migrateBtn.props.title)) && /10 分钟/.test(String(migrateBtn.props.title)),
  String(migrateBtn && migrateBtn.props.title));

// Simulate a long migration: POST /projectMigrate never resolves, while the
// status routes return a real host stage. Re-render must keep the refresh
// DISABLED with NO click handler, and the strip must show progress.
const longCalls = makeFetch({
  '/projectMigrate': () => new Promise(() => {}),
  '/projectMigrateStatus': () => ({
    migration: { active: true, stage: 'planning', project: 'demo', startedAt: Date.now() - 3000, detail: '调用 p/m 规划拆分' },
    llmRouteAvailable: true,
  }),
  default: () => WITH_PROJECT,
});
if (migrateBtn) migrateBtn.props.onClick();
const running = renderOnce(Page, hooks, seed);
await runEffects(running.effects);
tree = renderOnce(Page, hooks, seed).tree;
const busyRefresh = findButton(tree, '处理中');
check('处理中 button is DISABLED (not a clickable refresh)',
  !!busyRefresh && busyRefresh.props.disabled === true && busyRefresh.props.onClick === undefined,
  JSON.stringify({ found: !!busyRefresh, disabled: busyRefresh && busyRefresh.props.disabled, onClick: typeof (busyRefresh && busyRefresh.props.onClick) }));
const text = visibleText(tree);
check('progress strip names the action and the real host stage',
  /迁移 demo 处理中/.test(text) && /调用模型规划拆分/.test(text), text.slice(0, 400));
check('progress strip shows a live elapsed timer', /已等待/.test(text), text.slice(0, 400));
const allButtons = buttons(tree);
check('all page actions are locked while the migration is in flight',
  allButtons.length > 0 && allButtons.every((b) => b.props.disabled === true),
  `${allButtons.filter((b) => b.props.disabled === true).length}/${allButtons.length}`);
check('progress polling hits the dedicated status route',
  longCalls.some((c) => c.name === '/projectMigrateStatus'), longCalls.map((c) => c.name).join(','));

// Regression: a failed FIRST load still shows the dedicated error page with a
// retry button (a later refresh failure must only show a notice).
{
  const failHooks = [];
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
  const f = renderOnce(Page, failHooks, seed);
  await runEffects(f.effects);
  const errorTree = renderOnce(Page, failHooks, seed).tree;
  check('failed first load shows the dedicated retry page', /读取失败/.test(visibleText(errorTree)));
  check('retry button is present on the error page', !!findButton(errorTree, '重试'));
}

console.log(fail === 0 ? `\nALL PASS (${pass} passed)` : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
