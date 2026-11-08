/**
 * Suite 04 — repository-local memory model: project root detection, the
 * `safeMemoryRel` path gate, AGENTS.md index parsing/rendering, topic-file IO,
 * budget refusals, orphan detection, cross-file search, trash, the project
 * registry and the bulk directory scan.
 *
 * Creates `shared.projRoot`, reused by the migration suites.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findGitRepoRoot } from '../../dist/lib/projects.js';
import {
  resolveProjectRoot, readIndex, renderAgents, writeAgents, mutateIndex,
  safeMemoryRel, readMemoryFile, writeMemoryFile, appendMemoryFile,
  deleteMemoryFile, listMemoryFiles, searchMemoryFiles, residentChars, indexChars,
} from '../../dist/lib/project-memory.js';
import { readRegistry, registerProject, unregisterProject, listRegistered, rootForName, scanAndRegister } from '../../dist/lib/project-registry.js';
import { check, shared, testDir } from '../harness.mjs';

// 12. project root detection
check('resolveProjectRoot rejects home', resolveProjectRoot(os.homedir()) === null);
check('resolveProjectRoot rejects filesystem root', resolveProjectRoot(path.parse(testDir).root) === null);
const plainDir = fs.mkdtempSync(path.join(testDir, 'plain-'));
check('resolveProjectRoot falls back to cwd outside git', resolveProjectRoot(plainDir) === path.resolve(plainDir));
const repoDir = fs.mkdtempSync(path.join(testDir, 'repo-'));
const subDir = path.join(repoDir, 'src', 'deep');
fs.mkdirSync(subDir, { recursive: true });
fs.mkdirSync(path.join(repoDir, '.git'));
check('resolveProjectRoot uses the git root from a subdir', resolveProjectRoot(subDir) === path.resolve(repoDir));
check('findGitRepoRoot agrees with resolveProjectRoot', findGitRepoRoot(subDir) === path.resolve(repoDir));

// linked worktree: `.git` is a pointer file into <main>/.git/worktrees/<name>
const wtMain = fs.mkdtempSync(path.join(testDir, 'wt-main-'));
const wtDir = path.join(testDir, 'wt-linked');
fs.mkdirSync(path.join(wtMain, '.git', 'worktrees', 'wt-linked'), { recursive: true });
fs.writeFileSync(path.join(wtMain, '.git', 'worktrees', 'wt-linked', 'commondir'), '../..\n');
fs.mkdirSync(wtDir, { recursive: true });
fs.writeFileSync(path.join(wtDir, '.git'), `gitdir: ${path.join(wtMain, '.git', 'worktrees', 'wt-linked')}\n`);
check('linked worktree resolves to the main repository root', resolveProjectRoot(wtDir) === path.resolve(wtMain));

// --- path safety gate
const projRoot = fs.mkdtempSync(path.join(testDir, 'proj-'));
shared.projRoot = projRoot;
check('safe rel accepts memory/x.md', safeMemoryRel(projRoot, 'memory/x.md') === 'memory/x.md');
check('safe rel accepts bare x.md shorthand', safeMemoryRel(projRoot, 'x.md') === 'memory/x.md');
check('safe rel rejects traversal', safeMemoryRel(projRoot, 'memory/../../etc/passwd.md') === null);
check('safe rel rejects absolute', safeMemoryRel(projRoot, '/tmp/x.md') === null);
check('safe rel rejects windows drive path', safeMemoryRel(projRoot, 'C:/x.md') === null);
check('safe rel rejects non-markdown', safeMemoryRel(projRoot, 'memory/x.txt') === null);
check('safe rel rejects dotfile path', safeMemoryRel(projRoot, 'memory/.secret.md') === null);
check('safe rel rejects outside-memory prefix', safeMemoryRel(projRoot, 'other/x.md') === null);

// --- index parsing: canonical (only pointers) and resident+index forms
check('readIndex reports missing AGENTS.md', readIndex(projRoot).exists === false);
fs.writeFileSync(path.join(projRoot, 'AGENTS.md'), '@memory/overview.md — 迁移总览\n@memory/run.md\n');
const idxPure = readIndex(projRoot);
check('pure index has no resident content', idxPure.resident.length === 0 && idxPure.entries.length === 2);
check('index parses summary', idxPure.entries[0].summary === '迁移总览', idxPure.entries[0].summary);
check('index parses bare line with empty summary', idxPure.entries[1].summary === '');
check('index reports target file existence', idxPure.entries.every((e) => e.exists === false));
check('index renders canonical form', renderAgents([], idxPure.entries) === '@memory/overview.md — 迁移总览\n@memory/run.md\n');

fs.writeFileSync(path.join(projRoot, 'AGENTS.md'), [
  '# 项目规则',
  '- 构建：npm run build',
  '',
  '- @memory/build.md: 构建链路说明',
  '* @memory/test.md -- 测试说明',
  '这是一段常驻说明，不是索引',
  '@memory/overview.md — 概览',
].join('\n'));
const idxMixed = readIndex(projRoot);
check('resident prose kept out of the index', idxMixed.entries.length === 3, `entries=${idxMixed.entries.length}`);
check('resident prose preserved verbatim', idxMixed.resident.join('\n').includes('# 项目规则') && idxMixed.resident.join('\n').includes('这是一段常驻说明'));
check('index accepts bullet prefix', idxMixed.entries[0].file === 'memory/build.md');
check('index accepts colon separator', idxMixed.entries[0].summary === '构建链路说明', idxMixed.entries[0].summary);
check('index accepts star prefix and dash separator', idxMixed.entries[1].file === 'memory/test.md' && idxMixed.entries[1].summary === '测试说明');
check('render keeps resident above the index', renderAgents(idxMixed.resident, idxMixed.entries).startsWith('# 项目规则'));
fs.writeFileSync(path.join(projRoot, 'AGENTS.md'), '@memory/../escape.md — bad\n');
check('escaping pointer line is not an index entry', readIndex(projRoot).entries.length === 0);

// --- memory file IO
const wrote = await writeMemoryFile(projRoot, 'memory/build.md', '# 构建\n\nnpm run build\n');
check('writeMemoryFile writes the file', wrote.ok && fs.existsSync(path.join(projRoot, 'memory', 'build.md')));
check('readMemoryFile round-trips', readMemoryFile(projRoot, 'memory/build.md').includes('npm run build'));
check('readMemoryFile returns null for missing', readMemoryFile(projRoot, 'memory/nope.md') === null);
const tooBig = await writeMemoryFile(projRoot, 'memory/big.md', 'x'.repeat(50), 10);
check('writeMemoryFile enforces the per-file budget', tooBig.ok === false && !fs.existsSync(path.join(projRoot, 'memory', 'big.md')));
const appended = await appendMemoryFile(projRoot, 'memory/build.md', '## 附注\n\nexit=0 才算过\n', 20000);
check('appendMemoryFile appends a section', appended.ok && readMemoryFile(projRoot, 'memory/build.md').includes('exit=0 才算过'));

// --- index mutations respect budgets
const badWrite = await writeAgents(projRoot, ['rule '.repeat(100)], [], { residentCharLimit: 50 });
check('writeAgents refuses an over-budget resident block', badWrite.ok === false);
const goodWrite = await writeAgents(projRoot, ['- 构建：npm run build'], [
  { file: 'memory/build.md', summary: '构建链路' },
  { file: 'memory/test.md', summary: '测试' },
], { residentCharLimit: 6000, indexCharLimit: 4000 });
check('writeAgents writes resident + index', goodWrite.ok && readIndex(projRoot).entries.length === 2);
const badIdx = await writeAgents(projRoot, [], Array.from({ length: 200 }, (_, i) => ({ file: `memory/f${i}.md`, summary: 'x'.repeat(40) })), { indexCharLimit: 100 });
check('writeAgents refuses an over-budget index', badIdx.ok === false);
const deduped = await mutateIndex(projRoot, ({ resident, entries }) => ({ resident, entries: entries.filter((e) => e.file !== 'memory/test.md') }));
check('mutateIndex removes one entry', deduped.ok && readIndex(projRoot).entries.length === 1);

// --- orphan detection
await writeMemoryFile(projRoot, 'memory/orphan.md', '# 未索引\n');
check('orphans list unindexed files', readIndex(projRoot).orphans.includes('memory/orphan.md'));
check('listMemoryFiles finds all markdown', listMemoryFiles(projRoot).length >= 2);

// --- search across files
await writeMemoryFile(projRoot, 'memory/deploy.md', '# 部署\n\nAlex runs on gardener node\nmacOS arm64\n');
check('search matches multi-term AND across lines', searchMemoryFiles(projRoot, 'alex macOS', 10).length >= 1);
check('search is case-insensitive', searchMemoryFiles(projRoot, 'ALEX GARDENER', 10).length >= 1);
check('search misses when a term is absent', searchMemoryFiles(projRoot, 'alex windows', 10).length === 0);
check('search returns the file path', searchMemoryFiles(projRoot, 'gardener', 10)[0].file === 'memory/deploy.md');

// --- delete moves to .trash
const delProj = await deleteMemoryFile(projRoot, 'memory/orphan.md');
check('delete moves the file into memory/.trash', delProj.ok && delProj.trashed.startsWith('memory/.trash/'));
check('delete removes the original', !fs.existsSync(path.join(projRoot, 'memory', 'orphan.md')));
check('trash copy still exists', fs.existsSync(path.join(projRoot, ...delProj.trashed.split('/'))));

// --- char accounting
check('residentChars counts resident text', residentChars(['a', 'b']) === 3);
check('indexChars counts rendered index', indexChars([{ file: 'memory/a.md', summary: 's' }]) === '@memory/a.md — s\n'.length);

// 12b. project registry
const regDir = fs.mkdtempSync(path.join(testDir, 'registry-'));
registerProject(regDir, projRoot);
const regs = readRegistry(regDir);
check('registerProject records the root', regs.length === 1 && regs[0].root === path.resolve(projRoot));
check('registerProject derives the name from basename', regs[0].name === path.basename(projRoot));
check('rootForName resolves a registered project', rootForName(regDir, path.basename(projRoot)) === path.resolve(projRoot));
check('rootForName rejects unknown names', rootForName(regDir, 'nope') === null);
const secondRoot = fs.mkdtempSync(path.join(testDir, 'second-'));
fs.mkdirSync(path.join(secondRoot, 'memory'), { recursive: true });
fs.writeFileSync(path.join(secondRoot, 'AGENTS.md'), '@memory/a.md — x\n');
registerProject(regDir, secondRoot);
check('listRegistered flags missing memory', listRegistered(regDir).some((r) => r.root === path.resolve(secondRoot) && r.exists));
check('unregisterProject drops the record', unregisterProject(regDir, secondRoot) && !readRegistry(regDir).some((r) => r.root === path.resolve(secondRoot)));

// 12b-2. bulk directory scan
const scanBase = fs.mkdtempSync(path.join(testDir, 'scanbase-'));
const scanMem = fs.mkdtempSync(path.join(testDir, 'scanmem-'));
for (const rel of ['one', 'nested/two']) {
  const dir = path.join(scanBase, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '@memory/a.md — A\n');
}
fs.mkdirSync(path.join(scanBase, 'one', 'node_modules', 'x', '.git'), { recursive: true });
fs.mkdirSync(path.join(scanBase, '.hidden', '.git'), { recursive: true });
const scan1 = scanAndRegister(scanMem, scanBase);
check('scan finds repositories at several depths', scan1.roots.length === 2, JSON.stringify(scan1.roots));
check('scan registers each repository', readRegistry(scanMem).length === 2);
check('scan skips node_modules and dotted directories',
  !scan1.roots.some((r) => r.includes('node_modules') || r.includes('.hidden')));
const scan2 = scanAndRegister(scanMem, scanBase);
check('re-scan reports existing instead of duplicating', scan2.added.length === 0 && scan2.existing.length === 2);
check('scan of a missing directory is empty', scanAndRegister(scanMem, path.join(testDir, 'nope')).roots.length === 0);
// maxDepth 0 = only the parent directory itself is examined (it is not a repo)
check('scan with maxDepth 0 finds nothing', scanAndRegister(scanMem, scanBase, { maxDepth: 0 }).roots.length === 0);
// maxDepth 1 reaches `one` but not `nested/two`
const scanDeep = scanAndRegister(scanMem, scanBase, { maxDepth: 1 });
check('scan honours maxDepth', scanDeep.roots.length === 1 && scanDeep.roots[0].endsWith('one'), JSON.stringify(scanDeep.roots));
