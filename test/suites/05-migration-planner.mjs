/**
 * Suite 05 — the migration PLANNER: reply parsing, the validation gates that
 * make an LLM-written split safe, and the brief itself (canonical guide +
 * coarse-topic rule + few-shot).
 *
 * The end-to-end `migrateAgents` flows live in `13-migration-e2e.mjs`; this
 * suite is pure planning so a failure here points at the prompt/gates, not at
 * file writing.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  parsePlan, validatePlan, headingsOf,
  MIGRATION_SYSTEM_PROMPT, MIGRATION_EXAMPLE,
} from '../../dist/lib/project-migrate.js';
import { projectGuideText as migrationGuideText } from '../../dist/lib/project-guide.js';
import { check, shared, testDir } from '../harness.mjs';

const projRoot = shared.projRoot;
const exampleRoot = fs.mkdtempSync(path.join(testDir, 'mig-example-'));

// --- plans that fake heading preservation must be rejected
const longOriginal = [
  '# 项目说明', '',
  '## 构建', 'npm run build', '',
  '## 部署', 'systemctl restart app', '',
  '## 排障', 'check the logs first, then restart', '',
  '## 约定', 'never edit generated files by hand', '',
].join('\n');
const dumpPlan = parsePlan(JSON.stringify({
  resident: ['## 构建', '## 部署'],
  files: [{ file: 'memory/all.md', summary: 'x', content: longOriginal }],
}));
check('a plan that dumps the whole original into one file is rejected',
  /整份原文|丢失|什么都往里塞/.test(validatePlan(projRoot, longOriginal, dumpPlan, { scan: true }) || ''),
  validatePlan(projRoot, longOriginal, dumpPlan, { scan: true }));
const emptyResident = parsePlan(JSON.stringify({
  resident: [],
  files: [
    { file: 'memory/a.md', summary: 'x', content: '# 项目说明\n\n## 构建\nnpm run build\n' },
    { file: 'memory/b.md', summary: 'x', content: '## 部署\nsystemctl restart app\n' },
    { file: 'memory/c.md', summary: 'x', content: '## 排障\ncheck logs\n\n## 约定\nnever edit\n' },
  ],
}));
check('a plan with an empty resident block is rejected',
  /常驻区为空/.test(validatePlan(projRoot, longOriginal, emptyResident, { scan: true, maxFiles: 8 }) || ''));
const shrunk = parsePlan(JSON.stringify({
  resident: ['# 项目说明', '- 构建', '- 部署', '- 排障', '- 约定'],
  files: [],
}));
check('a plan whose output is much shorter than the original is rejected',
  /明显短于原文/.test(validatePlan(projRoot, longOriginal, shrunk, { scan: true }) || ''),
  validatePlan(projRoot, longOriginal, shrunk, { scan: true }));

// --- parse + gate basics
const original = '# 规则\n\n## 构建\nnpm run build\n\n## 部署\nsystemctl restart app\n';
check('headingsOf extracts headings', JSON.stringify(headingsOf(original)) === JSON.stringify(['规则', '构建', '部署']));
const goodPlan = parsePlan(JSON.stringify({
  resident: ['# 规则', '- 构建：npm run build'],
  files: [{ file: 'memory/deploy.md', summary: '部署步骤', content: '# 部署\nsystemctl restart app\n' }],
}));
check('parsePlan parses a plain JSON reply', goodPlan !== null && goodPlan.files.length === 1);
check('parsePlan tolerates a fenced block', parsePlan('```json\n{"resident":[],"files":[]}\n```') !== null);
check('parsePlan rejects garbage', parsePlan('not json at all') === null);
check('validatePlan accepts a heading-preserving plan', validatePlan(projRoot, original, goodPlan, { scan: true }) === null);
const lossyPlan = parsePlan(JSON.stringify({ resident: ['# 规则'], files: [] }));
check('validatePlan rejects a plan that drops headings', /丢失/.test(validatePlan(projRoot, original, lossyPlan) || ''));
const badPathPlan = parsePlan(JSON.stringify({ resident: [original], files: [{ file: '../escape.md', summary: 'x', content: 'y' }] }));
check('validatePlan rejects an escaping file path', /非法/.test(validatePlan(projRoot, original, badPathPlan) || ''));
const secretPlan = parsePlan(JSON.stringify({ resident: [original], files: [{ file: 'memory/k.md', summary: 'x', content: '# 构建\n\nAKIAIOSFODNN7EXAMPLE\n' }] }));
check('validatePlan rejects secrets via the scanner', validatePlan(projRoot, original, secretPlan, { scan: true }) !== null);

// --- the brief: canonical guide + coarse-topic rule + few-shot
check('migration system prompt includes the canonical authoring guide',
  MIGRATION_SYSTEM_PROMPT.includes('--- BEGIN AUTHORING GUIDE ---')
    && MIGRATION_SYSTEM_PROMPT.includes(migrationGuideText())
    && MIGRATION_SYSTEM_PROMPT.includes('--- END AUTHORING GUIDE ---'));
check('migration system prompt teaches the coarse-topic rule',
  /3-6 topic files/.test(MIGRATION_SYSTEM_PROMPT)
    && /Do NOT create one file per original heading/.test(MIGRATION_SYSTEM_PROMPT)
    && /status-and-roadmap/.test(MIGRATION_SYSTEM_PROMPT));
check('migration system prompt carries a document+output few-shot',
  MIGRATION_SYSTEM_PROMPT.includes('--- BEGIN EXAMPLE DOCUMENT ---')
    && MIGRATION_SYSTEM_PROMPT.includes(MIGRATION_EXAMPLE.document)
    && MIGRATION_SYSTEM_PROMPT.includes('--- BEGIN EXAMPLE OUTPUT ---')
    && MIGRATION_SYSTEM_PROMPT.includes('"file": "memory/status-and-roadmap.md"'));
check('the few-shot groups many source sections into few broad files',
  headingsOf(MIGRATION_EXAMPLE.document).length === 20
    && MIGRATION_EXAMPLE.plan.files.length === 6
    && MIGRATION_EXAMPLE.plan.files.every((f) => headingsOf(f.content).length === 4),
  `headings=${headingsOf(MIGRATION_EXAMPLE.document).length} files=${MIGRATION_EXAMPLE.plan.files.length}`);
check('the few-shot output itself passes the real validator',
  validatePlan(exampleRoot, MIGRATION_EXAMPLE.document, MIGRATION_EXAMPLE.plan, {
    scan: true, residentCharLimit: 6000, indexCharLimit: 4000,
  }) === null,
  validatePlan(exampleRoot, MIGRATION_EXAMPLE.document, MIGRATION_EXAMPLE.plan, {
    scan: true, residentCharLimit: 6000, indexCharLimit: 4000,
  }));
const tinyTopics = parsePlan(JSON.stringify({
  resident: [original],
  files: Array.from({ length: 9 }, (_, i) => ({
    file: `memory/t${i}.md`, summary: `第 ${i} 节`, content: `## 第 ${i} 节\n\n细节 ${i}\n`,
  })),
}));
check('validatePlan refuses a fragmented table-of-contents plan',
  /超过上限|合并成少数宽主题/.test(validatePlan(exampleRoot, original, tinyTopics) || ''),
  validatePlan(exampleRoot, original, tinyTopics));
const noSummary = parsePlan(JSON.stringify({
  resident: [original],
  files: [{ file: 'memory/deploy.md', content: '## 部署\nsystemctl restart app\n' }],
}));
check('validatePlan requires a when-to-read summary',
  /summary/.test(validatePlan(exampleRoot, original, noSummary) || ''),
  validatePlan(exampleRoot, original, noSummary));
const dumpAll = parsePlan(JSON.stringify({
  resident: [original],
  files: [{ file: 'memory/all.md', summary: '全部内容', content: original }],
}));
check('validatePlan rejects the catch-all all.md anti-pattern',
  /什么都往里塞/.test(validatePlan(exampleRoot, original, dumpAll) || ''),
  validatePlan(exampleRoot, original, dumpAll));
