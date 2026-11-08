/**
 * Suite 08 — the two tool surfaces and the authoring guide:
 *   - `memory` must edit the GLOBAL store, never a project file;
 *   - `project_memory` must maintain the AGENTS.md index on every mutation;
 *   - the guide is one source of truth rendered in two sizes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createMemoryStore } from '../../dist/lib/memory-store.js';
import { registerMemoryTool } from '../../dist/lib/memory-tool.js';
import { registerProjectMemoryTool } from '../../dist/lib/project-memory-tool.js';
import { projectGuideText, projectCoreLines, projectBootstrapBlock } from '../../dist/lib/project-guide.js';
import { readIndex, readMemoryFile } from '../../dist/lib/project-memory.js';
import { listRegistered } from '../../dist/lib/project-registry.js';
import { check, testDir } from '../harness.mjs';

// 15. memory-tool layer: update must target the GLOBAL store
let registeredTool;
const toolCtx = {
  tools: { register: (tool) => { registeredTool = tool; } },
  logger: { warn() {}, info() {} },
  llm: { stream: async function* () {} },
};
const globalStore = createMemoryStore({ dir: testDir });
registerMemoryTool(toolCtx, globalStore, {
  memoryCharLimit: 5000,
  userCharLimit: 8000,
  failureCharLimit: 10000,
  enableSecretScanning: true,
  usageNudgeThreshold: 0.9,
  autoConsolidate: false,
  consolidateStaleDays: 30,
  consolidateTimeoutMs: 1000,
});
await globalStore.add('memory', 'TOOL-GLOBAL-CONVENTION use pnpm');
const updResult = await registeredTool.execute(
  { action: 'update', match: 'TOOL-GLOBAL-CONVENTION', content: 'TOOL-GLOBAL-CONVENTION use pnpm always' },
  undefined,
);
check('tool update targets the global store', updResult.updated === true && updResult.which === 'memory', JSON.stringify(updResult));
const globalReadBack = await globalStore.read('memory', 5000);
check('tool update applied to the global store', globalReadBack.content.includes('pnpm always'));

// 15b. project_memory tool (AGENTS.md index + memory/ files)
let projTool;
const projToolCtx = {
  tools: { register: (tool) => { projTool = tool; } },
  logger: { warn() {}, info() {} },
  llm: { stream: async function* () {} },
};
const toolProjRoot = fs.mkdtempSync(path.join(testDir, 'toolproj-'));
fs.mkdirSync(path.join(toolProjRoot, '.git'));
const toolRegistryDir = fs.mkdtempSync(path.join(testDir, 'toolregistry-'));
registerProjectMemoryTool(projToolCtx, {
  config: {
    projectFileCharLimit: 20000,
    projectResidentCharLimit: 6000,
    projectIndexCharLimit: 4000,
    projectAutoMigrate: false,
    projectMigrateTimeoutMs: 1200000,
    enableSecretScanning: true,
    searchMaxResults: 10,
    memoryDir: toolRegistryDir,
  },
  cwdOf: () => toolProjRoot,
});
const execStub = { agent: undefined };
const written = await projTool.execute(
  { action: 'write', file: 'memory/build.md', summary: '构建与测试', content: '# 构建\n\nnpm run build\n' },
  execStub,
);
check('project_memory write creates the file', written.file === 'memory/build.md' && fs.existsSync(path.join(toolProjRoot, 'memory', 'build.md')), JSON.stringify(written));
check('project_memory write indexes the file', readIndex(toolProjRoot).entries.some((e) => e.file === 'memory/build.md'));
const listed = await projTool.execute({ action: 'list' }, execStub);
check('project_memory list reports the entry', listed.entries.length === 1 && listed.entries[0].summary === '构建与测试');
const readBack = await projTool.execute({ action: 'read', file: 'memory/build.md' }, execStub);
check('project_memory read returns content', readBack.exists === true && readBack.content.includes('npm run build'));
const appended2 = await projTool.execute({ action: 'append', file: 'memory/build.md', content: '## 附注\nexit=0' }, execStub);
check('project_memory append grows the file', appended2.chars > readBack.chars);
const addedResident = await projTool.execute({ action: 'add_resident', content: '- 构建前先跑 npm run build' }, execStub);
check('project_memory add_resident writes the resident block', addedResident.added === 1 && readIndex(toolProjRoot).resident.includes('- 构建前先跑 npm run build'));
const removedResident = await projTool.execute({ action: 'remove_resident', match: '先跑 npm run build' }, execStub);
check('project_memory remove_resident drops the line', removedResident.removed === 1 && readIndex(toolProjRoot).resident.length === 0);
// update (resident): one-step replace of a stale rule, then a not-found error path
const addedResident2 = await projTool.execute({ action: 'add_resident', content: '- 提交前必须全绿' }, execStub);
check('project_memory add_resident seeds the update test', addedResident2.added === 1);
const updatedResident = await projTool.execute({ action: 'update', match: '提交前必须全绿', content: '- 提交前必须全绿（typecheck + smoke）' }, execStub);
check('project_memory update rewrites a resident line in place',
  updatedResident.replaced === 1 && readIndex(toolProjRoot).resident.includes('- 提交前必须全绿（typecheck + smoke）'));
const updateResidentMiss = await projTool.execute({ action: 'update', match: '不存在的行', content: 'x' }, execStub).catch((e) => e);
check('project_memory update errors on missing resident line', updateResidentMiss instanceof Error);
// update (topic file): same semantics inside memory/*.md
const updatedTopic = await projTool.execute({ action: 'update', file: 'memory/build.md', match: 'npm run build', content: 'npm run build && npm run typecheck' }, execStub);
check('project_memory update rewrites a topic-file line',
  updatedTopic.file === 'memory/build.md' && readMemoryFile(toolProjRoot, 'memory/build.md').includes('npm run build && npm run typecheck'));
const updateTopicMiss = await projTool.execute({ action: 'update', file: 'memory/build.md', match: '不存在的行', content: 'x' }, execStub).catch((e) => e);
check('project_memory update errors on missing topic line', updateTopicMiss instanceof Error);
const searched = await projTool.execute({ action: 'search', query: 'npm build' }, execStub);
check('project_memory search finds the topic file', searched.matchCount >= 1 && searched.hits[0].file === 'memory/build.md');
const deletedProj = await projTool.execute({ action: 'delete', file: 'memory/build.md' }, execStub);
check('project_memory delete trashes the file', deletedProj.deleted === true && deletedProj.trashed.startsWith('memory/.trash/'));
check('project_memory delete removes the index line', readIndex(toolProjRoot).entries.length === 0);
const escapeAttempt = await projTool.execute({ action: 'write', file: '../escape.md', summary: 'x', content: 'y' }, execStub).catch((e) => e);
check('project_memory rejects an escaping path', escapeAttempt instanceof Error);
const blockedWrite = await projTool.execute(
  { action: 'write', file: 'memory/secret.md', summary: 'x', content: 'AKIAIOSFODNN7EXAMPLE' },
  execStub,
).catch((e) => e);
check('project_memory rejects secrets', blockedWrite instanceof Error);

// 15c. authoring guide: one source of truth, two sizes
const guideText = projectGuideText();
const coreLines = projectCoreLines();
check('guide is substantial', guideText.length > 1500, `chars=${guideText.length}`);
check('guide opens with the core recap', coreLines.every((line) => guideText.includes(line)));
check('core lines stay small (injected every request)', coreLines.join('\n').length < 900, `chars=${coreLines.join('\n').length}`);
check('guide explains both zones', /常驻区/.test(guideText) && /检索区/.test(guideText));
check('guide names the real tool actions', ['project_memory list', 'append', 'add_resident', 'migrate'].every((t) => guideText.includes(t)));
check('guide states the shipped 6000-char resident budget', /默认 6000 字符/.test(guideText));
check('guide lists anti-patterns', /不要这样做/.test(guideText));
check('guide mentions the credentials rule', /凭据|token|私钥/.test(guideText));
check('bootstrap block names the root and the tool',
  projectBootstrapBlock('/tmp/x').includes('/tmp/x') && projectBootstrapBlock('/tmp/x').includes('project_memory'));

// The guide action must not enroll the repository: a lookup is not a memory.
const guideRoot = fs.mkdtempSync(path.join(testDir, 'guiderepo-'));
fs.mkdirSync(path.join(guideRoot, '.git'));
const guideRegistry = fs.mkdtempSync(path.join(testDir, 'guideregistry-'));
let guideTool;
registerProjectMemoryTool({ tools: { register: (t) => { guideTool = t; } }, logger: { warn: () => {}, info: () => {} } }, {
  config: {
    projectFileCharLimit: 20000, projectResidentCharLimit: 6000, projectIndexCharLimit: 4000,
    projectAutoMigrate: false, projectMigrateTimeoutMs: 1200000,
    enableSecretScanning: true, searchMaxResults: 10, memoryDir: guideRegistry,
  },
  cwdOf: () => guideRoot,
});
const guideResult = await guideTool.execute({ action: 'guide' }, { agent: undefined });
check('project_memory guide returns the full text', guideResult.guide === guideText);
check('the guide renderer emits prose, not JSON', guideTool.output.render({ action: 'guide' }, guideResult)[0].text.startsWith('# 项目记忆写法'));
check('project_memory guide does not register the project', listRegistered(guideRegistry).length === 0);
const guideNoCwd = await guideTool.execute({ action: 'guide' }, { agent: undefined });
check('project_memory guide works without a project cwd', guideNoCwd.guide === guideText);
const listRender = guideTool.output.render({ action: 'list' }, { entries: [] });
check('other actions still render JSON', listRender[0].text.startsWith('```json'));
