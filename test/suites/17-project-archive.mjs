/**
 * Suite 17 — project-memory archive: zip codec + export/import round trip.
 *
 * Covers the cross-machine migration path: export a project's AGENTS.md +
 * memory/** as a zip, import it into another project, and every hostile input
 * that must be refused before a single byte is written (traversal entries,
 * foreign zips, deflate bombs, oversized files, secrets, budget overflow).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createZip, readZip } from '../../dist/lib/zip.js';
import { buildProjectArchive, importProjectArchive, archiveFileName, ARCHIVE_FORMAT } from '../../dist/lib/project-archive.js';
import { readIndex, writeMemoryFile } from '../../dist/lib/project-memory.js';
import { check, testDir } from '../harness.mjs';

// ---------------------------------------------------------------- zip codec
{
  const big = 'x'.repeat(50_000) + ' 中文 '.repeat(2000);
  const zip = createZip([
    { name: 'a.txt', data: 'hello' },
    { name: 'nested/b.md', data: big },
    { name: 'empty.txt', data: '' },
    { name: '中文/名字.md', data: '# 中文名\n' },
  ]);
  const entries = readZip(zip);
  const byName = new Map(entries.map((e) => [e.name, e.data.toString('utf8')]));
  check('zip round-trips a stored (tiny) entry', byName.get('a.txt') === 'hello');
  check('zip round-trips a deflated entry byte-for-byte', byName.get('nested/b.md') === big);
  check('zip keeps empty files', byName.get('empty.txt') === '');
  check('zip keeps UTF-8 entry names', byName.get('中文/名字.md') === '# 中文名\n');
  check('zip deflates compressible data (archive much smaller than payload)',
    zip.length < big.length / 4, `${zip.length} vs ${big.length}`);

  let threw = false;
  try { readZip(Buffer.from('definitely not a zip at all')); } catch { threw = true; }
  check('readZip rejects a non-zip buffer', threw);

  // CRC must be checked: flip one byte inside the compressed payload.
  const corrupt = Buffer.from(zip);
  const nameAt = corrupt.indexOf(Buffer.from('a.txt'));
  corrupt[nameAt + 'a.txt'.length] ^= 0xff;
  let crcThrew = false;
  try { readZip(corrupt); } catch (e) { crcThrew = /CRC|解压/.test(String(e && e.message)); }
  check('readZip verifies CRC and refuses corrupted data', crcThrew);

  // A deflate bomb must fail on maxOutputLength, not allocate.
  const bomb = createZip([{ name: 'bomb.md', data: 'a'.repeat(2_000_000) }]);
  let bombThrew = false;
  try { readZip(bomb, { maxEntryBytes: 1000 }); } catch { bombThrew = true; }
  check('readZip refuses an entry beyond maxEntryBytes', bombThrew);

  // entry-count cap
  const many = createZip(Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.md`, data: String(i) })));
  let countThrew = false;
  try { readZip(many, { maxEntries: 5 }); } catch { countThrew = true; }
  check('readZip refuses too many entries', countThrew);
}

// ------------------------------------------------------------ export/import
function makeProject(label) {
  const root = fs.mkdtempSync(path.join(testDir, `arch-${label}-`));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AGENTS.md'),
    '# 规则\n\n- 构建：npm run build\n\n@memory/overview.md — 总览\n@memory/deploy.md — 部署\n');
  fs.writeFileSync(path.join(root, 'memory', 'overview.md'), '# 总览\n\n这是一个项目。\n');
  fs.writeFileSync(path.join(root, 'memory', 'deploy.md'), '# 部署\n\nsystemctl restart x\n');
  return root;
}

{
  const src = makeProject('src');
  const archive = buildProjectArchive(src, 'demo', new Date(2026, 10, 8, 15, 15, 2));
  check('export filename is sortable and zip-suffixed',
    archive.filename === 'demo-memory-20261108-151502.zip', archive.filename);
  check('export carries AGENTS.md + every topic file', archive.files.length === 3, JSON.stringify(archive.files));
  const entries = readZip(archive.buffer);
  const names = entries.map((e) => e.name).sort();
  check('archive entries are manifest + AGENTS.md + memory/**',
    JSON.stringify(names) === JSON.stringify(['AGENTS.md', 'manifest.json', 'memory/deploy.md', 'memory/overview.md']),
    names.join(','));
  const manifest = JSON.parse(entries.find((e) => e.name === 'manifest.json').data.toString('utf8'));
  check('manifest identifies the archive format and version',
    manifest.format === ARCHIVE_FORMAT && manifest.version === 1, JSON.stringify(manifest.format));

  // ---- import into a fresh project
  const dst = fs.mkdtempSync(path.join(testDir, 'arch-dst-'));
  fs.mkdirSync(path.join(dst, '.git'));
  const imported = await importProjectArchive(dst, archive.buffer, {
    project: 'demo',
    scan: true,
    residentCharLimit: 6000,
    indexCharLimit: 4000,
    fileCharLimit: 20000,
  });
  check('import into a fresh project succeeds', imported.ok === true, imported.error || '');
  check('import writes AGENTS.md and both topic files', imported.written.length === 2, JSON.stringify(imported.written));
  check('imported index parses back to the same entries',
    JSON.stringify(readIndex(dst).entries.map((e) => [e.file, e.summary]))
    === JSON.stringify([['memory/overview.md', '总览'], ['memory/deploy.md', '部署']]),
    JSON.stringify(readIndex(dst).entries));
  check('imported resident block is preserved verbatim',
    readIndex(dst).resident.join('\n').includes('- 构建：npm run build'), readIndex(dst).resident.join('|'));
  check('imported topic file content matches the source',
    fs.readFileSync(path.join(dst, 'memory', 'deploy.md'), 'utf8').includes('systemctl restart x'));

  // ---- re-import over existing memory: backup + trash, never silent loss
  fs.writeFileSync(path.join(dst, 'AGENTS.md'), '旧的常驻内容\n\n@memory/old.md — 旧\n');
  fs.writeFileSync(path.join(dst, 'memory', 'overview.md'), '# 被我改坏的总览\n');
  const again = await importProjectArchive(dst, archive.buffer, { project: 'demo', scan: true });
  check('re-import succeeds over existing memory', again.ok === true, again.error || '');
  check('re-import backs up the previous AGENTS.md', !!again.backup && fs.existsSync(path.join(dst, again.backup)), String(again.backup));
  check('re-import moves every overwritten topic file into memory/.trash',
    again.trashed.length === 2 && again.trashed.every((t) => fs.existsSync(path.join(dst, t))), JSON.stringify(again.trashed));
  check('re-import restores the archive content',
    fs.readFileSync(path.join(dst, 'memory', 'overview.md'), 'utf8').includes('这是一个项目'));

  // ---- export with nothing to export
  const empty = fs.mkdtempSync(path.join(testDir, 'arch-empty-'));
  let emptyThrew = '';
  try { buildProjectArchive(empty, 'empty'); } catch (e) { emptyThrew = String(e && e.message); }
  check('export refuses a project without AGENTS.md', /没有可导出的记忆/.test(emptyThrew), emptyThrew);
}

// --------------------------------------------------------- hostile archives
const badRoot = () => {
  const root = fs.mkdtempSync(path.join(testDir, 'arch-bad-'));
  fs.mkdirSync(path.join(root, '.git'));
  return root;
};
const opts = { project: 'bad', scan: true, residentCharLimit: 6000, indexCharLimit: 4000, fileCharLimit: 20000 };

{
  // path traversal inside the zip
  const root = badRoot();
  const zip = createZip([
    { name: 'AGENTS.md', data: '@memory/ok.md — ok\n' },
    { name: 'memory/../../escape.md', data: 'pwned' },
  ]);
  const res = await importProjectArchive(root, zip, opts);
  check('import refuses traversal entry names', res.ok === false && /无法识别/.test(String(res.error)), String(res.error));
  check('traversal import wrote nothing', !fs.existsSync(path.join(root, 'AGENTS.md')) && !fs.existsSync(path.join(root, '..', 'escape.md')));
}
{
  // a plain zip that is not ours
  const root = badRoot();
  const zip = createZip([
    { name: 'manifest.json', data: JSON.stringify({ format: 'someone/else', version: 1 }) },
    { name: 'AGENTS.md', data: '# x\n' },
  ]);
  const res = await importProjectArchive(root, zip, opts);
  check('import refuses a foreign manifest format', res.ok === false && /不是本插件的项目记忆包/.test(String(res.error)), String(res.error));
}
{
  // newer archive version
  const root = badRoot();
  const zip = createZip([
    { name: 'manifest.json', data: JSON.stringify({ format: ARCHIVE_FORMAT, version: 99 }) },
    { name: 'AGENTS.md', data: '# x\n' },
  ]);
  const res = await importProjectArchive(root, zip, opts);
  check('import refuses a newer archive version', res.ok === false && /先升级插件/.test(String(res.error)), String(res.error));
}
{
  // missing AGENTS.md
  const root = badRoot();
  const zip = createZip([{ name: 'memory/a.md', data: '# a\n' }]);
  const res = await importProjectArchive(root, zip, opts);
  check('import refuses an archive without AGENTS.md', res.ok === false && /缺少 AGENTS.md/.test(String(res.error)), String(res.error));
}
{
  // secret scanning
  const root = badRoot();
  const zip = createZip([
    { name: 'AGENTS.md', data: '@memory/key.md — key\n' },
    { name: 'memory/key.md', data: 'key = sk-abcdefghijklmnopqrstuvwxyz012345\n' },
  ]);
  const res = await importProjectArchive(root, zip, opts);
  check('import refuses scanner-blocked content', res.ok === false && /内容被拒绝/.test(String(res.error)), String(res.error));
  check('blocked import leaves no files behind', !fs.existsSync(path.join(root, 'AGENTS.md')));
}
{
  // budget overflow: resident too long
  const root = badRoot();
  const zip = createZip([{ name: 'AGENTS.md', data: 'x'.repeat(500) + '\n' }]);
  const res = await importProjectArchive(root, zip, { ...opts, residentCharLimit: 100 });
  check('import refuses an over-budget resident block', res.ok === false && /常驻区超预算/.test(String(res.error)), String(res.error));
}
{
  // a zip with one wrapping folder (what `zip -r demo.zip demo/` produces)
  const root = badRoot();
  const zip = createZip([
    { name: 'demo/AGENTS.md', data: '@memory/a.md — A\n' },
    { name: 'demo/memory/a.md', data: '# A\n' },
  ]);
  const res = await importProjectArchive(root, zip, opts);
  check('import unwraps a single top-level folder', res.ok === true, res.error || '');
  check('unwrapped import landed at the project root',
    fs.existsSync(path.join(root, 'AGENTS.md')) && fs.existsSync(path.join(root, 'memory', 'a.md')));
}
{
  // index pointing at a topic file that is neither archived nor on disk
  const root = badRoot();
  const zip = createZip([{ name: 'AGENTS.md', data: '@memory/ghost.md — ghost\n' }]);
  const res = await importProjectArchive(root, zip, opts);
  check('import warns about an index line whose file is missing',
    res.ok === true && res.warnings.some((w) => w.includes('memory/ghost.md')), JSON.stringify(res.warnings));
}
{
  // wrong-project warning (import the demo archive into a project with another name)
  const src = makeProject('named');
  const archive = buildProjectArchive(src, 'other-machine-name');
  const root = badRoot();
  const res = await importProjectArchive(root, archive.buffer, { ...opts, project: 'local-name' });
  check('import reports a cross-project archive by name',
    res.ok === true && res.warnings.some((w) => /other-machine-name/.test(w)), JSON.stringify(res.warnings));
}
{
  // a topic file written by the archive writer is readable by readMemoryFile
  const root = badRoot();
  const folder = path.join(root, 'memory', 'deep');
  fs.mkdirSync(folder, { recursive: true });
  const zip = createZip([
    { name: 'AGENTS.md', data: '@memory/deep/x.md — deep\n' },
    { name: 'memory/deep/x.md', data: '# deep\n' },
  ]);
  const res = await importProjectArchive(root, zip, opts);
  check('import supports nested memory/ folders', res.ok === true && res.written.includes('memory/deep/x.md'), JSON.stringify(res.written));
}

check('archiveFileName sanitizes the project name',
  archiveFileName('a/b c', new Date('2026-01-02T03:04:05Z')).startsWith('a-b-c-memory-'));

// keep the writer's import used (guards against a dead export in the test itself)
void writeMemoryFile;
