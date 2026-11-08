/**
 * Suite 13 — `migrateAgents` end to end: planner wiring (system brief + user
 * document), timeout propagation, refusal paths that must leave the file
 * untouched, preview mode, and the re-run guards.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  migrateAgents, DEFAULT_MIGRATION_TIMEOUT_MS, DEFAULT_MIGRATION_MAX_FILES, MIGRATION_SYSTEM_PROMPT,
} from '../../dist/lib/project-migrate.js';
import { readIndex } from '../../dist/lib/project-memory.js';
import { defaultLlmRoute, resolveLlmRoute } from '../../dist/lib/llm-helper.js';
import { check, testDir } from '../harness.mjs';

const migCtx = { logger: { warn() {}, info() {} }, llm: { stream: async function* () {} } };
const migReply = JSON.stringify({
  resident: ['# 项目规则', '- 构建：npm run build'],
  files: [{ file: 'memory/deploy.md', summary: '部署步骤', content: '# 部署\n\nsystemctl restart app\n' }],
});

// 26. a valid plan is applied and indexed
const migRoot = fs.mkdtempSync(path.join(testDir, 'mig-'));
fs.writeFileSync(path.join(migRoot, 'AGENTS.md'), [
  '# 项目规则',
  '',
  '## 构建',
  'npm run build',
  '',
  '## 部署',
  'systemctl restart app',
  '',
].join('\n'));
const migOk = await migrateAgents(migCtx, migRoot, { provider: 'p', model: 'm' }, {
  apply: true, scan: true, fileCharLimit: 20000, residentCharLimit: 6000, indexCharLimit: 4000,
  plan: async () => migReply,
});
check('migrateAgents applies a valid plan', migOk.migrated === true, migOk.reason);
const migIndex = readIndex(migRoot);
check('migration keeps resident rules', migIndex.resident.join('\n').includes('构建：npm run build'));
check('migration writes the topic file', fs.readFileSync(path.join(migRoot, 'memory', 'deploy.md'), 'utf8').includes('systemctl'));
check('migration indexes the topic', migIndex.entries.length === 1 && migIndex.entries[0].file === 'memory/deploy.md');
check('migration left a backup of the original', migOk.backup !== undefined && fs.existsSync(path.join(migRoot, migOk.backup)));

// a migration with no model route must say what to do, in words a user can act on
const migNoRouteRoot = fs.mkdtempSync(path.join(testDir, 'mignoroute-'));
fs.writeFileSync(path.join(migNoRouteRoot, 'AGENTS.md'), '# 规则\n\n## 构建\nnpm run build\n');
const migNoRoute = await migrateAgents(migCtx, migNoRouteRoot, undefined, { apply: true });
check('missing LLM route points at the default model config',
  migNoRoute.migrated === false && /agent-default-model/.test(migNoRoute.reason || '') && !/先.*会话请求/.test(migNoRoute.reason || ''),
  migNoRoute.reason);

// progress callbacks must expose the long LLM stage before any disk write;
// the default timeout is twenty minutes, and the planner call receives it.
const migProgressRoot = fs.mkdtempSync(path.join(testDir, 'migprogress-'));
fs.writeFileSync(path.join(migProgressRoot, 'AGENTS.md'), '# 项目规则\n\n## 构建\nnpm run build\n\n## 部署\nsystemctl restart app\n');
const seenStages = [];
const seenProgress = [];
const seenSignals = [];
const seenRequests = [];
const timeoutCtx = {
  logger: { warn() {}, info() {} },
  llm: {
    stream: (opts) => {
      seenSignals.push(opts.signal);
      seenRequests.push(opts);
      return async function* () { yield { type: 'text-delta', text: migReply }; }();
    },
  },
};
const progOk = await migrateAgents(timeoutCtx, migProgressRoot, { provider: 'p', model: 'm' }, {
  apply: true, scan: true, fileCharLimit: 20000, residentCharLimit: 6000, indexCharLimit: 4000,
  onProgress: (progress) => { seenStages.push(progress.stage); seenProgress.push(progress); },
  timeoutMs: 1200000,
});
check('migration reports planning and completion stages',
  progOk.migrated === true && seenStages.includes('planning') && seenStages.includes('completed'),
  seenStages.join(','));
check('default migration timeout is twenty minutes',
  DEFAULT_MIGRATION_TIMEOUT_MS === 1200000, String(DEFAULT_MIGRATION_TIMEOUT_MS));
check('planner detail names the twenty-minute timeout',
  seenProgress.some((p) => p.stage === 'planning' && /20 分钟/.test(p.detail || '')),
  JSON.stringify(seenProgress.find((p) => p.stage === 'planning')));
check('configured timeout reaches the LLM call signal',
  seenSignals.length === 1 && seenSignals[0] instanceof AbortSignal, String(seenSignals.length));
check('real planner request carries guide + few-shot in system and only source in user',
  seenRequests.length === 1
    && seenRequests[0].system === MIGRATION_SYSTEM_PROMPT
    && seenRequests[0].messages.length === 1
    && /BEGIN DOCUMENT TO MIGRATE/.test(seenRequests[0].messages[0].content[0].text)
    && !/BEGIN AUTHORING GUIDE|BEGIN EXAMPLE DOCUMENT/.test(seenRequests[0].messages[0].content[0].text));

// the host's default provider/model is available without a prior chat request
const defaultRouteCtx = {
  get: (name) => name === 'agentDefaultModel'
    ? { currentSelection: () => ({ provider: '9router', model: 'cbcn/hy4free' }) }
    : undefined,
};
const inherited = defaultLlmRoute(defaultRouteCtx);
check('defaultLlmRoute inherits the host default model',
  inherited && inherited.provider === '9router' && inherited.model === 'cbcn/hy4free',
  JSON.stringify(inherited));
check('resolveLlmRoute prefers a real session route',
  resolveLlmRoute(defaultRouteCtx, { provider: 'session-p', model: 'session-m' }).provider === 'session-p');
check('resolveLlmRoute falls back without a session route',
  resolveLlmRoute(defaultRouteCtx, undefined).model === 'cbcn/hy4free');
check('defaultLlmRoute degrades on hosts without the service',
  defaultLlmRoute({ get: () => undefined }) === undefined && defaultLlmRoute({}) === undefined);

// a lossy plan must leave the file untouched
const migRoot2 = fs.mkdtempSync(path.join(testDir, 'mig2-'));
const prose = '# 项目规则\n\n## 构建\nnpm run build\n\n## 部署\nsystemctl restart app\n';
fs.writeFileSync(path.join(migRoot2, 'AGENTS.md'), prose);
const lossyReply = JSON.stringify({ resident: ['# 项目规则'], files: [] });
const migBad = await migrateAgents(migCtx, migRoot2, { provider: 'p', model: 'm' }, {
  apply: true, scan: true, plan: async () => lossyReply,
});
check('migration refuses a lossy plan', migBad.migrated === false && /丢失/.test(migBad.reason || ''), migBad.reason);
check('refused migration leaves AGENTS.md intact', fs.readFileSync(path.join(migRoot2, 'AGENTS.md'), 'utf8') === prose);
const migPreview = await migrateAgents(migCtx, migRoot2, { provider: 'p', model: 'm' }, {
  apply: false, plan: async () => migReply,
});
check('preview mode does not write', migPreview.migrated === false && migPreview.reason === 'preview' && migPreview.plan !== undefined);

// a fragmented (one-file-per-section) plan is refused BEFORE any write
const migFragmentedRoot = fs.mkdtempSync(path.join(testDir, 'migfragmented-'));
fs.writeFileSync(path.join(migFragmentedRoot, 'AGENTS.md'), prose);
const fragmentedReply = JSON.stringify({
  resident: ['# 项目规则', '- 构建：npm run build'],
  files: Array.from({ length: DEFAULT_MIGRATION_MAX_FILES + 1 }, (_, i) => ({
    file: `memory/topic-${i}.md`, summary: `第 ${i} 节`, content: `## 第 ${i} 节\n\n细节 ${i}\n`,
  })),
});
const migFragmented = await migrateAgents(migCtx, migFragmentedRoot, { provider: 'p', model: 'm' }, {
  apply: true, scan: true, fileCharLimit: 20000, residentCharLimit: 6000, indexCharLimit: 4000,
  plan: async () => fragmentedReply,
});
check('migration refuses a table-of-contents plan',
  migFragmented.migrated === false && /超过上限|合并成少数宽主题/.test(migFragmented.reason || ''),
  migFragmented.reason);
check('fragmented migration writes no backup and no memory directory',
  fs.readFileSync(path.join(migFragmentedRoot, 'AGENTS.md'), 'utf8') === prose
    && !fs.existsSync(path.join(migFragmentedRoot, 'memory'))
    && fs.readdirSync(migFragmentedRoot).every((n) => !n.startsWith('AGENTS.md.bak-')));

// re-running a migration must never unindex existing topic files
const migRoot4 = fs.mkdtempSync(path.join(testDir, 'mig4-'));
fs.mkdirSync(path.join(migRoot4, 'memory'), { recursive: true });
for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(migRoot4, 'memory', n + '.md'), `# ${n}\n`);
fs.writeFileSync(path.join(migRoot4, 'AGENTS.md'), [
  '# 规则', '', '- 先构建', '',
  '@memory/a.md — A', '@memory/b.md — B', '@memory/c.md — C', '',
].join('\n'));
const migAlready = await migrateAgents(migCtx, migRoot4, { provider: 'p', model: 'm' }, {
  apply: true, scan: true, fileCharLimit: 20000, residentCharLimit: 6000, indexCharLimit: 4000,
  plan: async () => JSON.stringify({ resident: ['- 先构建'], files: [{ file: 'memory/new.md', summary: '新', content: '# 规则\n' }] }),
});
check('migration refuses an already-migrated project', migAlready.migrated === false && /属于迁移后形态/.test(migAlready.reason || ''), migAlready.reason);
check('refused re-run keeps every index entry', readIndex(migRoot4).entries.length === 3);
check('refused re-run creates no orphans', readIndex(migRoot4).orphans.length === 0);
// even with force, a plan may not silently unindex a surviving topic file
const migForced = await migrateAgents(migCtx, migRoot4, { provider: 'p', model: 'm' }, {
  apply: true, force: true, scan: true, fileCharLimit: 20000, residentCharLimit: 6000, indexCharLimit: 4000,
  plan: async () => JSON.stringify({ resident: ['- 先构建'], files: [{ file: 'memory/new.md', summary: '新', content: '# 规则\n' }] }),
});
const forcedEntries = readIndex(migRoot4).entries.map((e) => e.file);
check('forced migration still keeps unmentioned entries',
  migForced.migrated === true && forcedEntries.includes('memory/a.md') && forcedEntries.includes('memory/new.md'),
  JSON.stringify(forcedEntries));

// the migrate entry point must agree with the UI's "can migrate" predicate:
// prose-only AGENTS.md => allowed; indexed AGENTS.md => refused.
const migRoot5 = fs.mkdtempSync(path.join(testDir, 'mig5-'));
fs.writeFileSync(path.join(migRoot5, 'AGENTS.md'), '# 规则\n\n## 构建\nnpm run build\n');
const proseAllowed = await migrateAgents(migCtx, migRoot5, { provider: 'p', model: 'm' }, {
  apply: false,
  plan: async () => JSON.stringify({ resident: ['# 规则', '- 构建：npm run build'], files: [] }),
});
check('prose AGENTS.md is migratable (preview succeeds)',
  proseAllowed.reason === 'preview' && proseAllowed.plan !== undefined, proseAllowed.reason);
fs.writeFileSync(path.join(migRoot5, 'AGENTS.md'), '@memory/a.md — A\n');
const indexedRefused = await migrateAgents(migCtx, migRoot5, { provider: 'p', model: 'm' }, {
  apply: false, plan: async () => JSON.stringify({ resident: [], files: [] }),
});
check('indexed AGENTS.md reports not-migratable',
  indexedRefused.migrated === false && /无需迁移/.test(indexedRefused.reason || ''), indexedRefused.reason);

// an already-migrated file is a no-op
const migRoot3 = fs.mkdtempSync(path.join(testDir, 'mig3-'));
fs.writeFileSync(path.join(migRoot3, 'AGENTS.md'), '@memory/a.md — 主题\n');
const migNoop = await migrateAgents(migCtx, migRoot3, { provider: 'p', model: 'm' }, { plan: async () => migReply });
check('migration skips an already-canonical file', migNoop.migrated === false && /无需迁移/.test(migNoop.reason || ''));

// the injected planner receives the new user brief; production sends the long
// reference material as `system`, not as a second user message to migrate.
{
  const original = '# 规则\n\n## 构建\nnpm run build\n\n## 部署\nsystemctl restart app\n';
  const briefRoot = fs.mkdtempSync(path.join(testDir, 'mig-brief-'));
  fs.writeFileSync(path.join(briefRoot, 'AGENTS.md'), original);
  const briefCtx = { logger: { warn() {}, info() {} }, llm: { stream: async function* () {} } };
  let brief = '';
  await migrateAgents(briefCtx, briefRoot, { provider: 'p', model: 'm' }, {
    apply: false,
    plan: async (prompt) => {
      brief = prompt;
      return JSON.stringify({
        resident: ['# 规则', '- 构建：npm run build'],
        files: [{ file: 'memory/deploy.md', summary: '部署步骤', content: '# 部署\n\nsystemctl restart app\n' }],
      });
    },
  });
  check('injected planner user brief points at the system guide and carries only the source',
    /Apply the system brief/.test(brief)
      && brief.includes('--- BEGIN DOCUMENT TO MIGRATE ---')
      && brief.includes(original)
      && !brief.includes('--- BEGIN AUTHORING GUIDE ---')
      && !brief.includes('--- BEGIN EXAMPLE OUTPUT ---'));
}
