/**
 * Suite 12 — the admin HTTP surface (guarded routes): route family, restore by
 * snapshot name, refused-migration reporting, and single-flight migration with
 * real stage progress.
 *
 * Exercises `makeAdminRoutes` directly with fake req/res objects — no server,
 * no browser.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createMemoryStore } from '../../dist/lib/memory-store.js';
import { createStandingStore } from '../../dist/lib/standing.js';
import { makeAdminRoutes, backupAll, listBackups } from '../../dist/lib/admin.js';
import { registerProject } from '../../dist/lib/project-registry.js';
import { BIG_LIMITS, check, shared, testDir } from '../harness.mjs';

const backupMemDir = shared.backupMemDir;

/** Minimal response object the routes can write into (headers captured too,
 *  so the binary archive download can be asserted). `body` keeps the raw value
 *  a Buffer route writes; JSON routes still store a string. */
const makeRes = () => ({
  statusCode: 0, body: '', headers: {},
  setHeader(key, value) { this.headers[key.toLowerCase()] = String(value); },
  writeHead(code, headers) {
    this.statusCode = code;
    if (headers) for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = String(v);
  },
  end(body) { this.body = Buffer.isBuffer(body) ? body : String(body); },
});

/** Minimal POST request carrying one JSON body. */
const postReq = (body) => ({
  method: 'POST', url: '/',
  headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' },
  [Symbol.asyncIterator]: async function* () {
    if (body !== undefined) yield Buffer.from(JSON.stringify(body));
  },
});

/** Minimal POST request carrying a raw (binary) body. */
const rawReq = (buf) => ({
  method: 'POST', url: '/',
  headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' },
  [Symbol.asyncIterator]: async function* () { yield buf; },
});

/** Minimal GET request. */
const getReq = () => ({
  method: 'GET', url: '/',
  headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' },
});

// 25. admin project routes: registry gate + write/read/delete
const routeCtx = {
  logger: { warn() {}, info() {} },
  llm: { stream: async function* () {} },
  get: () => undefined,
};
const routes = makeAdminRoutes({
  store: createMemoryStore({ dir: backupMemDir, limits: BIG_LIMITS }),
  standing: createStandingStore({ dir: backupMemDir, maxEntries: 20, maxChars: 2000 }),
  vector: { available: async () => false, search: async () => null, rebuild: async () => 0 },
  cfg: { dir: backupMemDir, autoBackupMin: 0, autoSwitchOnPiLoss: false, projectMigrateTimeoutMs: 1200000 },
  ctx: routeCtx,
  getRoute: () => undefined,
  profilePatch: path.join(testDir, 'cordis.patch.yml'),
  log: () => {},
});
check('admin exposes the project route family', ['projectRead', 'projectWrite', 'projectCreate', 'projectDelete', 'projectResident', 'projectMigrate', 'projectMigrateStatus', 'projectRegister', 'projectGuide', 'projectExport', 'projectImport']
  .every((name) => routes.some((r) => r.path === `/api/persona-memory/${name}`)));

// 25-archive. export/import round trip through the HTTP routes
{
  const arcMemDir = fs.mkdtempSync(path.join(testDir, 'arcadmin-'));
  const arcSrc = fs.mkdtempSync(path.join(testDir, 'arcsrcrepo-'));
  fs.mkdirSync(path.join(arcSrc, '.git'));
  fs.mkdirSync(path.join(arcSrc, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(arcSrc, 'AGENTS.md'), '- 构建：npm run build\n\n@memory/a.md — A\n');
  fs.writeFileSync(path.join(arcSrc, 'memory', 'a.md'), '# A\n\n内容\n');
  registerProject(arcMemDir, arcSrc);
  const arcDst = fs.mkdtempSync(path.join(testDir, 'arcdstrepo-'));
  fs.mkdirSync(path.join(arcDst, '.git'));
  registerProject(arcMemDir, arcDst);
  const arcRoutes = makeAdminRoutes({
    store: createMemoryStore({ dir: arcMemDir, limits: BIG_LIMITS }),
    standing: createStandingStore({ dir: arcMemDir, maxEntries: 20, maxChars: 2000 }),
    vector: {},
    cfg: { dir: arcMemDir, autoBackupMin: 0 },
    ctx: { logger: { warn() {}, info() {} } },
    getRoute: () => undefined,
    profilePatch: path.join(testDir, 'arc.yml'),
    log: () => {},
  });
  const exportRoute = arcRoutes.find((r) => r.path === '/api/persona-memory/projectExport');
  const importRoute = arcRoutes.find((r) => r.path === '/api/persona-memory/projectImport');

  const exportRes = makeRes();
  await exportRoute.handler(postReq({ project: path.basename(arcSrc) }), exportRes);
  const zipBytes = Buffer.isBuffer(exportRes.body) ? exportRes.body : Buffer.from(String(exportRes.body || ''), 'binary');
  check('projectExport answers a zip, not JSON',
    exportRes.statusCode === 200 && exportRes.headers['content-type'] === 'application/zip',
    `${exportRes.statusCode} ${exportRes.headers['content-type']}`);
  check('projectExport names the download after the project',
    new RegExp(`^attachment; filename="${path.basename(arcSrc)}-memory-\\d{8}-\\d{6}\\.zip"$`).test(String(exportRes.headers['content-disposition'])),
    String(exportRes.headers['content-disposition']));

  const importRes = makeRes();
  importRes.url = '';
  await importRoute.handler({ ...rawReq(zipBytes), url: `/?project=${encodeURIComponent(path.basename(arcDst))}` }, importRes);
  const importPayload = JSON.parse(importRes.body || '{}');
  check('projectImport writes the archive into the target project',
    importRes.statusCode === 200 && importPayload.ok === true && fs.existsSync(path.join(arcDst, 'memory', 'a.md')),
    `${importRes.statusCode} ${importRes.body.slice(0, 200)}`);
  check('projectImport keeps the source project untouched',
    fs.existsSync(path.join(arcSrc, 'memory', 'a.md')) && !fs.existsSync(path.join(arcSrc, 'AGENTS.md.bak-')),
    'source changed');

  const badImport = makeRes();
  await importRoute.handler({ ...rawReq(Buffer.from('not a zip')), url: `/?project=${encodeURIComponent(path.basename(arcDst))}` }, badImport);
  check('projectImport refuses a non-zip body with a readable reason',
    badImport.statusCode === 400 && /zip/.test(String(JSON.parse(badImport.body || '{}').error)),
    badImport.body);

  const unknownImport = makeRes();
  await importRoute.handler({ ...rawReq(zipBytes), url: '/?project=nope' }, unknownImport);
  check('projectImport refuses an unregistered project name', unknownImport.statusCode === 404, String(unknownImport.statusCode));
}

// 25a. the restore route restores the snapshot it is asked for (by name)
{
  const rMem = fs.mkdtempSync(path.join(testDir, 'rtmem-'));
  const rBase = path.join(testDir, 'rtbackups');
  const rCfg = { dir: rMem, backupDir: rBase, autoBackupMin: 0, autoSwitchOnPiLoss: false };
  fs.writeFileSync(path.join(rMem, 'MEMORY.md'), 'old <!-- created=2026-01-01, last=2026-01-01 -->\n');
  await backupAll(rCfg);
  await new Promise((r) => setTimeout(r, 1100));
  fs.writeFileSync(path.join(rMem, 'MEMORY.md'), 'new <!-- created=2026-01-01, last=2026-01-01 -->\n');
  await backupAll(rCfg);
  const rtRoutes = makeAdminRoutes({
    store: createMemoryStore({ dir: rMem, limits: BIG_LIMITS }),
    standing: createStandingStore({ dir: rMem, maxEntries: 20, maxChars: 2000 }),
    vector: {},
    cfg: rCfg,
    ctx: { logger: { warn() {}, info() {} } },
    getRoute: () => undefined,
    profilePatch: path.join(testDir, 'rt.yml'),
    log: () => {},
  });
  const rtRoute = rtRoutes.find((r) => r.path === '/api/persona-memory/restoreLatest');
  const callRestore = async (body) => {
    const res = makeRes();
    await rtRoute.handler(postReq(body), res);
    return { status: res.statusCode, payload: JSON.parse(res.body || '{}') };
  };
  const oldName = listBackups(rCfg).filter((b) => b.kind === 'history').sort((a, b) => a.name.localeCompare(b.name))[0].name;
  const got = await callRestore({ snapshot: oldName });
  const restoredText = fs.readFileSync(path.join(rMem, 'MEMORY.md'), 'utf8');
  check('restoreLatest restores the requested snapshot, not latest',
    got.status === 200 && restoredText.includes('old'), `${got.status} ${restoredText.trim().slice(0, 20)}`);
  check('restoreLatest echoes which snapshot it used',
    got.payload.snapshot === oldName, String(got.payload.snapshot));
  const bad = await callRestore({ snapshot: '../../etc' });
  check('restoreLatest refuses an unknown/traversal snapshot name', bad.status === 404, String(bad.status));
  const def = await callRestore({});
  check('restoreLatest defaults to latest when no snapshot is given',
    def.status === 200 && fs.readFileSync(path.join(rMem, 'MEMORY.md'), 'utf8').includes('new'), def.payload.message);
}

// 25b. a refused migration reports its reason (not a bare HTTP error)
{
  const migAdminDir = fs.mkdtempSync(path.join(testDir, 'migadmin-'));
  const migAdminRepo = fs.mkdtempSync(path.join(testDir, 'migadminrepo-'));
  fs.mkdirSync(path.join(migAdminRepo, '.git'));
  // already-migrated shape => migrateAgents refuses
  fs.mkdirSync(path.join(migAdminRepo, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(migAdminRepo, 'memory', 'a.md'), '# A\n');
  fs.writeFileSync(path.join(migAdminRepo, 'AGENTS.md'), '- rule\n\n@memory/a.md — A\n');
  registerProject(migAdminDir, migAdminRepo);
  const migRoutes = makeAdminRoutes({
    store: createMemoryStore({ dir: migAdminDir, limits: BIG_LIMITS }),
    standing: createStandingStore({ dir: migAdminDir, maxEntries: 20, maxChars: 2000 }),
    vector: {},
    cfg: { dir: migAdminDir, autoBackupMin: 0, projectMigrateTimeoutMs: 1200000 },
    ctx: { logger: { warn() {}, info() {} } },
    getRoute: () => undefined,
    profilePatch: path.join(testDir, 'p.yml'),
    log: () => {},
  });
  const route = migRoutes.find((r) => r.path === '/api/persona-memory/projectMigrate');
  const res = makeRes();
  await route.handler(postReq({ project: path.basename(migAdminRepo), apply: true }), res);
  const payload = JSON.parse(res.body || '{}');
  check('refused migration answers 200, not 400', res.statusCode === 200, String(res.statusCode));
  check('refused migration carries a readable reason', typeof payload.reason === 'string' && payload.reason.length > 0, payload.reason);
  // The progress route must report a FINISHED state, not leave the page "busy"
  // forever after a refused migration.
  const statusRoute = migRoutes.find((r) => r.path === '/api/persona-memory/projectMigrateStatus');
  const statusRes = makeRes();
  await statusRoute.handler(getReq(), statusRes);
  const after = JSON.parse(statusRes.body || '{}').migration || {};
  check('migration progress clears after a refusal', after.active === false && after.outcome === 'refused', JSON.stringify(after));
  const statusPayloadRoute = migRoutes.find((r) => r.path === '/api/persona-memory/status');
  const adminStatusRes = makeRes();
  await statusPayloadRoute.handler(getReq(), adminStatusRes);
  const adminStatus = JSON.parse(adminStatusRes.body || '{}');
  check('status payload exposes whether an LLM route exists',
    adminStatus.llmRouteAvailable === false && adminStatus.migration && adminStatus.migration.active === false,
    JSON.stringify({ llmRouteAvailable: adminStatus.llmRouteAvailable, migration: adminStatus.migration }));
}

// 25c. admin migration: single-flight + real stage progress while the planner runs
{
  const progDir = fs.mkdtempSync(path.join(testDir, 'prog-'));
  const progRepo = fs.mkdtempSync(path.join(testDir, 'progrepo-'));
  fs.mkdirSync(path.join(progRepo, '.git'));
  fs.writeFileSync(path.join(progRepo, 'AGENTS.md'), '# 项目规则\n\n## 构建\nnpm run build\n\n## 部署\nsystemctl restart app\n');
  registerProject(progDir, progRepo);
  let releasePlanner;
  const plannerGate = new Promise((resolve) => { releasePlanner = resolve; });
  const plan = JSON.stringify({
    resident: ['# 项目规则', '- 构建：npm run build'],
    files: [{ file: 'memory/deploy.md', summary: '部署', content: '# 部署\n\nsystemctl restart app\n' }],
  });
  const stages = [];
  // The host's real planner path is ctx.llm.stream (see lib/llm-helper.ts).
  // Holding this generator at a gate makes the LLM call observably in flight
  // while the progress route is polled.
  const seenTimeouts = [];
  const slowCtx = {
    logger: { warn() {}, info() {} },
    llm: {
      stream: (opts) => {
        seenTimeouts.push(Math.round(opts.signal?.timeout ?? 0));
        return async function* () {
          await plannerGate;
          yield { type: 'text-delta', text: plan };
        }();
      },
    },
  };
  const progRoutes = makeAdminRoutes({
    store: createMemoryStore({ dir: progDir, limits: BIG_LIMITS }),
    standing: createStandingStore({ dir: progDir, maxEntries: 20, maxChars: 2000 }),
    vector: {},
    cfg: { dir: progDir, autoBackupMin: 0, projectMigrateTimeoutMs: 900000 },
    ctx: slowCtx,
    getRoute: () => ({ provider: 'p', model: 'm' }),
    profilePatch: path.join(testDir, 'prog.yml'),
    log: (line) => stages.push(line),
  });
  const call = async (route, body, method = 'POST') => {
    const res = makeRes();
    await route.handler(method === 'GET' ? getReq() : postReq(body), res);
    return { status: res.statusCode, payload: JSON.parse(res.body || '{}') };
  };
  const migrateRoute = progRoutes.find((r) => r.path === '/api/persona-memory/projectMigrate');
  const statusRoute = progRoutes.find((r) => r.path === '/api/persona-memory/projectMigrateStatus');
  const statusAdmin = progRoutes.find((r) => r.path === '/api/persona-memory/status');

  const reqBody = { project: path.basename(progRepo), apply: true };
  const running = call(migrateRoute, reqBody);
  // The route reads the request body before starting the planner; give it a
  // few macrotasks to reach the gated LLM call.
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  const inFlight = await call(statusRoute, undefined, 'GET');
  check('migration progress reports a real stage while the planner runs',
    inFlight.payload.migration.active === true && inFlight.payload.migration.stage === 'planning',
    JSON.stringify(inFlight.payload.migration));
  const statusPayload = (await call(statusAdmin, undefined, 'GET')).payload;
  check('status payload reports the available LLM route',
    statusPayload.llmRouteAvailable === true
      && statusPayload.llmRoute.provider === 'p' && statusPayload.llmRoute.model === 'm',
    JSON.stringify(statusPayload.llmRoute));
  const second = await call(migrateRoute, reqBody);
  check('a second migration is refused while one is in flight',
    second.status === 200 && second.payload.migrated === false && /已有迁移正在处理/.test(second.payload.reason),
    second.payload.reason);
  releasePlanner();
  const finished = await running;
  check('the in-flight migration eventually completes', finished.status === 200 && finished.payload.migrated === true,
    JSON.stringify(finished.payload));
  const after = await call(statusRoute, undefined, 'GET');
  check('migration progress clears after completion',
    after.payload.migration.active === false && after.payload.migration.outcome === 'completed',
    JSON.stringify(after.payload.migration));
  check('migration stages are logged for diagnosis',
    stages.some((line) => line.includes('stage=planning')) && stages.some((line) => line.includes('stage=completed')),
    String(stages.length));
  check('admin migration passes the configured timeout to the planner',
    seenTimeouts.includes(900000), JSON.stringify(seenTimeouts));
  check('progress detail shows the configured 15-minute timeout',
    stages.some((line) => line.includes('最长 15 分钟')), stages.find((line) => line.includes('stage=planning')) || '');
}
