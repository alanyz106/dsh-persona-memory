/**
 * Suite 11 — backup & restore:
 *   - `latest/` is an exact MIRROR of reality (never an accumulating pile),
 *   - dated history snapshots are individually restorable,
 *   - retention (`backupKeep`) is configurable, 0 = latest-only,
 *   - shipped config defaults match the operator's profile shape.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  backupAll, restoreFromLatest, backupPaths, pruneSnapshots,
  backupKeep, listBackups, resolveSnapshotDir, CFG_DEFAULTS, BACKUP_KEEP,
} from '../../dist/lib/admin.js';
import { registerProject, unregisterProject, listRegistered } from '../../dist/lib/project-registry.js';
import { check, shared, testDir } from '../harness.mjs';

// 24. admin backup/restore covers project memory (AGENTS.md + memory/**)
const backupMemDir = fs.mkdtempSync(path.join(testDir, 'backupmem-'));
shared.backupMemDir = backupMemDir;
const backupProjRoot = fs.mkdtempSync(path.join(testDir, 'backupproj-'));
fs.writeFileSync(path.join(backupMemDir, 'MEMORY.md'), 'global entry <!-- created=2026-01-01, last=2026-01-01 -->\n');
registerProject(backupMemDir, backupProjRoot);
fs.writeFileSync(path.join(backupProjRoot, 'AGENTS.md'), '- resident rule\n\n@memory/a.md — 主题 A\n');
fs.mkdirSync(path.join(backupProjRoot, 'memory', 'sub'), { recursive: true });
fs.writeFileSync(path.join(backupProjRoot, 'memory', 'a.md'), '# A\n');
fs.writeFileSync(path.join(backupProjRoot, 'memory', 'sub', 'b.md'), '# B\n');
// Never touch the real ~/.dsh/memory-backup: an earlier version of this test
// deposited ~60 throwaway project snapshots into the live backup directory.
const backupCfg = { dir: backupMemDir, backupDir: path.join(testDir, 'backups') };
const BACKUP_LATEST = backupPaths(backupCfg, { history: false }).latest;
const backupResult = await backupAll(backupCfg);
check('backupAll reports success', backupResult.ok === true, backupResult.message);
const projName = path.basename(backupProjRoot);
const projBackupDir = path.join(BACKUP_LATEST, 'projects', projName);
check('backup keeps AGENTS.md per project', fs.existsSync(path.join(projBackupDir, 'AGENTS.md')));
check('backup recurses into memory/', fs.existsSync(path.join(projBackupDir, 'memory', 'sub', 'b.md')));
check('backup keeps the flat global file', fs.existsSync(path.join(BACKUP_LATEST, 'MEMORY.md')));
// mutate then restore
fs.writeFileSync(path.join(backupProjRoot, 'AGENTS.md'), 'clobbered\n');
fs.writeFileSync(path.join(backupProjRoot, 'memory', 'a.md'), 'clobbered\n');
const restored = await restoreFromLatest(backupCfg);
check('restoreFromLatest reports restored files', restored >= 2, String(restored));
check('restore brings AGENTS.md back', fs.readFileSync(path.join(backupProjRoot, 'AGENTS.md'), 'utf8').includes('resident rule'));
check('restore brings memory files back', fs.readFileSync(path.join(backupProjRoot, 'memory', 'a.md'), 'utf8') === '# A\n');

// 24b. dated history snapshots (so an accidental delete is recoverable)
{
  const histMem = fs.mkdtempSync(path.join(testDir, 'histmem-'));
  const histBase = path.join(testDir, 'histbackups');
  const histCfg = { dir: histMem, backupDir: histBase };
  fs.writeFileSync(path.join(histMem, 'MEMORY.md'), 'v1 entry <!-- created=2026-01-01, last=2026-01-01 -->\n');
  const run = await backupAll(histCfg, { history: true });
  check('backupAll writes a dated history snapshot', run.ok && fs.existsSync(path.join(histBase, 'history')), run.message);
  const snaps = fs.readdirSync(path.join(histBase, 'history'));
  check('history snapshot contains the memory file',
    snaps.length === 1 && fs.existsSync(path.join(histBase, 'history', snaps[0], 'MEMORY.md')));
  // the snapshot keeps the OLD content even after the live file changes
  fs.writeFileSync(path.join(histMem, 'MEMORY.md'), 'v2 entry <!-- created=2026-01-01, last=2026-01-01 -->\n');
  await backupAll(histCfg, { history: true });
  const firstSnap = fs.readdirSync(path.join(histBase, 'history')).sort()[0];
  const kept = fs.readFileSync(path.join(histBase, 'history', firstSnap, 'MEMORY.md'), 'utf8');
  check('an older snapshot keeps the pre-change content', kept.includes('v1 entry'), kept.slice(0, 40));
  // restore from an explicit snapshot
  const restoredFromSnap = await restoreFromLatest(histCfg, histMem, path.join(histBase, 'history', firstSnap));
  const after = fs.readFileSync(path.join(histMem, 'MEMORY.md'), 'utf8');
  check('restoreFromLatest can restore an explicit snapshot', restoredFromSnap >= 1 && after.includes('v1 entry'));
  // pruning
  for (let i = 0; i < 5; i++) fs.mkdirSync(path.join(histBase, 'history', `2020-01-0${i + 1}T00-00-00`), { recursive: true });
  const removed = pruneSnapshots(path.join(histBase, 'history'), 3);
  check('pruneSnapshots keeps only the newest N', removed > 0 && fs.readdirSync(path.join(histBase, 'history')).length === 3,
    `removed=${removed} left=${fs.readdirSync(path.join(histBase, 'history')).length}`);
}

// 24c. shipped defaults follow the operator's custom profile shape
check('shipped config defaults use the operator profile values',
  CFG_DEFAULTS.learnEnabled === false
    && CFG_DEFAULTS.projectResidentCharLimit === 6000
    && CFG_DEFAULTS.projectMigrateTimeoutMs === 1200000
    && CFG_DEFAULTS.autoBackupMin === 1440
    && CFG_DEFAULTS.backupKeep === 10
    && BACKUP_KEEP === 10,
  JSON.stringify({ learnEnabled: CFG_DEFAULTS.learnEnabled, resident: CFG_DEFAULTS.projectResidentCharLimit,
    migrateTimeout: CFG_DEFAULTS.projectMigrateTimeoutMs, autoBackupMin: CFG_DEFAULTS.autoBackupMin,
    backupKeep: CFG_DEFAULTS.backupKeep, BACKUP_KEEP }));

// 24d. retention is configurable (backupKeep) and every snapshot is restorable
{
  const keepMem = fs.mkdtempSync(path.join(testDir, 'keepmem-'));
  const keepBase = path.join(testDir, 'keepbackups');
  fs.writeFileSync(path.join(keepMem, 'MEMORY.md'), 'base <!-- created=2026-01-01, last=2026-01-01 -->\n');
  check('backupKeep defaults to 10', backupKeep({}) === 10, String(backupKeep({})));
  check('backupKeep accepts a configured number', backupKeep({ backupKeep: 3 }) === 3);
  check('backupKeep accepts the string form from the YAML patch', backupKeep({ backupKeep: '5' }) === 5);
  check('backupKeep clamps negatives to 0', backupKeep({ backupKeep: -2 }) === 0);
  check('backupKeep ignores garbage', backupKeep({ backupKeep: 'nonsense' }) === 10);

  // keep=2: the third run must evict the oldest dated snapshot, latest stays one.
  const keepCfg = { dir: keepMem, backupDir: keepBase, backupKeep: 2 };
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(path.join(keepMem, 'MEMORY.md'), `v${i} <!-- created=2026-01-01, last=2026-01-01 -->\n`);
    await backupAll(keepCfg);
    await new Promise((r) => setTimeout(r, 1100)); // distinct second-resolution stamps
  }
  const histDirs = fs.readdirSync(path.join(keepBase, 'history'));
  check('backupAll honours the configured retention count', histDirs.length === 2, `left=${histDirs.length}`);

  // keep=0: latest-only, no history dir written.
  const offCfg = { dir: keepMem, backupDir: path.join(testDir, 'offbackups'), backupKeep: 0 };
  const offRun = await backupAll(offCfg);
  check('backupKeep=0 writes no history snapshot',
    offRun.ok && !fs.existsSync(path.join(testDir, 'offbackups', 'history'))
      && fs.existsSync(path.join(testDir, 'offbackups', 'latest', 'MEMORY.md')), offRun.message);

  // The list must expose every snapshot with a timestamp, latest first.
  const listed = listBackups(keepCfg);
  check('listBackups lists latest plus every history snapshot', listed.length === 3,
    JSON.stringify(listed.map((b) => b.name)));
  check('listBackups puts latest first and marks it as such',
    listed[0].name === 'latest' && listed[0].kind === 'latest' && listed[0].restorable === true);
  check('every history row carries a timestamp', listed.slice(1)
    .every((b) => b.kind === 'history' && typeof b.mtime === 'string' && b.mtime.length > 0));
  check('listBackups orders history newest first',
    listed.slice(1).map((b) => b.name).join() === listed.slice(1).map((b) => b.name).sort().reverse().join());

  // Name -> dir resolution: only real names, never a path from the browser.
  const oldestName = listed[listed.length - 1].name;
  const resolved = resolveSnapshotDir(keepCfg, oldestName);
  check('resolveSnapshotDir maps a listed name to its dir',
    resolved === path.join(keepBase, 'history', oldestName), String(resolved));
  check('resolveSnapshotDir resolves latest', resolveSnapshotDir(keepCfg, 'latest') === path.join(keepBase, 'latest'));
  check('resolveSnapshotDir rejects a traversal path',
    resolveSnapshotDir(keepCfg, '../../etc') === null && resolveSnapshotDir(keepCfg, keepBase) === null);
  check('resolveSnapshotDir rejects an unknown name', resolveSnapshotDir(keepCfg, '2020-01-01T00-00-00') === null);

  // Restoring the OLDEST snapshot must bring back its content, not latest's.
  const oldestContent = fs.readFileSync(path.join(keepBase, 'history', oldestName, 'MEMORY.md'), 'utf8');
  fs.writeFileSync(path.join(keepMem, 'MEMORY.md'), 'clobbered <!-- created=2026-01-01, last=2026-01-01 -->\n');
  const restoredOld = await restoreFromLatest(keepCfg, keepMem, resolveSnapshotDir(keepCfg, oldestName));
  const backOld = fs.readFileSync(path.join(keepMem, 'MEMORY.md'), 'utf8');
  check('an arbitrary history snapshot is restorable',
    restoredOld >= 1 && backOld === oldestContent, backOld.trim().slice(0, 30));
}

// 24e. `latest/` is a MIRROR, not an accumulating pile of overwrites.
//      Regression: overwriting file-by-file left ghosts behind forever — a
//      project that left the registry, a deleted topic file, or a fixture from
//      an aborted test stayed in latest/, so latest/ drifted from reality and
//      its file count stopped matching a same-instant history snapshot.
{
  const mirMem = fs.mkdtempSync(path.join(testDir, 'mirmem-'));
  const mirBase = path.join(testDir, 'mirbackups');
  const mirCfg = { dir: mirMem, backupDir: mirBase, backupKeep: 5 };
  const mirProjA = fs.mkdtempSync(path.join(testDir, 'mirprojA-'));
  const mirProjB = fs.mkdtempSync(path.join(testDir, 'mirprojB-'));
  for (const [root, tag] of [[mirProjA, 'A'], [mirProjB, 'B']]) {
    fs.writeFileSync(path.join(root, 'AGENTS.md'), `- rule ${tag}\n\n@memory/a.md — A\n`);
    fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(root, 'memory', 'a.md'), `# ${tag}\n`);
  }
  fs.writeFileSync(path.join(mirMem, 'MEMORY.md'), 'mirror <!-- created=2026-01-01, last=2026-01-01 -->\n');
  registerProject(mirMem, mirProjA);
  registerProject(mirMem, mirProjB);
  await backupAll(mirCfg);
  const countFiles = (p) => fs.existsSync(p)
    ? fs.readdirSync(p, { withFileTypes: true })
        .reduce((n, e) => n + (e.isDirectory() ? countFiles(path.join(p, e.name)) : 1), 0)
    : 0;
  const beforeCount = countFiles(path.join(mirBase, 'latest'));
  check('a fresh backup mirrors every registered project',
    fs.existsSync(path.join(mirBase, 'latest', 'projects', path.basename(mirProjA), 'memory', 'a.md'))
    && fs.existsSync(path.join(mirBase, 'latest', 'projects', path.basename(mirProjB), 'memory', 'a.md')));
  check('latest and the same run history snapshot have equal file counts',
    beforeCount === countFiles(path.join(mirBase, 'history', fs.readdirSync(path.join(mirBase, 'history'))[0])),
    `latest=${beforeCount}`);

  // drop the project from the registry + delete a topic file, then back up again
  fs.rmSync(path.join(mirProjB, 'memory', 'a.md'));
  check('unregisterProject removes the project from the registry',
    unregisterProject(mirMem, mirProjB) === true
    && listRegistered(mirMem).every((p) => p.name !== path.basename(mirProjB)));
  await backupAll(mirCfg);
  check('latest drops a project that left the registry',
    !fs.existsSync(path.join(mirBase, 'latest', 'projects', path.basename(mirProjB))));
  check('latest keeps the surviving project intact',
    fs.existsSync(path.join(mirBase, 'latest', 'projects', path.basename(mirProjA), 'memory', 'a.md')));
  check('latest file count shrinks instead of accumulating', countFiles(path.join(mirBase, 'latest')) < beforeCount,
    `${countFiles(path.join(mirBase, 'latest'))} < ${beforeCount}`);

  // no staging/retired leftovers after a normal run
  const stray = fs.readdirSync(mirBase).filter((n) => n.includes('.staging-') || n.includes('.retired-'));
  check('the mirror swap leaves no temp dirs behind', stray.length === 0, stray.join(','));
  check('latest still has the global memory file',
    fs.readFileSync(path.join(mirBase, 'latest', 'MEMORY.md'), 'utf8').includes('mirror'));
}
