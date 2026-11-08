/**
 * One-shot migration of an existing AGENTS.md into the resident + index shape.
 *
 * The interesting constraint: a repository's AGENTS.md is usually a real
 * instruction document (build commands, forbidden edits, architecture notes).
 * Rewriting it badly means the model silently loses rules it used to obey —
 * the worst possible outcome for a memory plugin. So the migration is a
 * *planner + validator* pair:
 *
 *   1. an auxiliary LLM call (the session's own model route) is briefed with
 *      the canonical authoring guide and a worked "coarse topics" example,
 *      then proposes a split into resident rules and a SMALL number of
 *      aggregated `memory/*.md` topic files,
 *   2. every heading in the original must be traceable in the result, and the
 *      plan must not fragment the document into one tiny file per heading,
 *   3. only a plan that passes validation plus the content scanner, the
 *      character budgets and the index/anti-fragmentation gates is written to
 *      disk. Otherwise nothing changes and the caller gets the reason.
 *
 * Validation-not-trust is what makes an LLM-written migration safe here: a
 * hallucinated summary is caught by the heading check, a plan that drops a
 * section can never replace the file, and a plan that slices the document into
 * a dozen index lines is refused before any topic file is written.
 */
import fs from 'node:fs';
import { scanContent } from './secret-scanner.js';
import { callLlm, type LlmRoute } from './llm-helper.js';
import { projectGuideText } from './project-guide.js';
import type { Context } from '@deepseek-ai/cordis';
import {
  readIndex,
  writeAgents,
  writeMemoryFile,
  readMemoryFile,
  listMemoryFiles,
  safeMemoryRel,
  residentChars,
  indexChars,
  type AgentsBudget,
} from './project-memory.js';

export interface MigrationFile {
  file: string;
  summary: string;
  content: string;
}

export interface MigrationPlan {
  resident: string[];
  files: MigrationFile[];
}

export interface MigrationResult {
  migrated: boolean;
  reason?: string;
  plan?: MigrationPlan;
  written?: string[];
  backup?: string;
}

/** Stages of one migration run, surfaced to the admin page while the planner runs. */
export type MigrationStage =
  | 'starting'
  | 'checking'
  | 'planning'
  | 'validating'
  | 'writing'
  | 'completed'
  | 'refused'
  | 'failed';

/** Progress callback — best-effort; a broken reporter must never fail a migration. */
export type MigrationProgressFn = (progress: { stage: MigrationStage; detail?: string }) => void;

/**
 * Migration planning can involve a long AGENTS.md and a slow reasoning model.
 * Ten minutes is the default; admin deployments may raise it further through
 * `projectMigrateTimeoutMs`.
 */
export const DEFAULT_MIGRATION_TIMEOUT_MS = 600_000;

/**
 * A migration that produces 17 one-heading topic files is worse than no
 * migration: the index stops being a "when to read this" map and becomes a
 * table of contents. The validator refuses this shape outright, and the
 * planner brief below tells the model what to aim for instead.
 */
export const DEFAULT_MIGRATION_MAX_FILES = 8;

/**
 * Worked few-shot example, modelled on a real repository's migrated
 * AGENTS.md (six broad index lines: status-and-roadmap / environment /
 * dataset-and-annotation / models-and-code / protocol-and-online / pitfalls).
 *
 * The pre-migration prose is reconstructed as EIGHTEEN short sections that
 * are grouped into SIX topic files. That is the lesson the example teaches:
 * many original headings -> few broad files, each keeping SEVERAL original
 * headings verbatim. Repository-specific paths/hosts are genericised: this
 * text ships inside the plugin and must not carry a user's project details.
 *
 * Document and plan are generated from ONE data structure so the example can
 * never drift into dropping a heading or a paragraph — and so a smoke test can
 * run it through the real validator.
 */
const EXAMPLE_RESIDENT: string[] = [
  '# AGENTS.md — 示例项目开发约定',
  '',
  '本项目训练检测器 + 编码器，破解某类点选验证码；原始方案见 `docs/PLAN.md`（部分结论已被后续记录修正）。常驻区只放硬约束，其余细节见末尾索引。',
  '',
  '## 硬性约束',
  '',
  '- 训练只在服务器 GPU 环境跑；本地 4GB 显卡只验证代码路径，禁止训练。',
  '- 本地 Python 用指定解释器；`pip` 走本机代理，没开代理先开系统代理。',
  '- 服务器联网命令先设代理与镜像变量，`.bashrc` 里的旧镜像已失效。',
  '- `.bat` 启动器必须 CRLF + 纯 ASCII，改完校验 `nonASCII=0`，否则 cmd 双击闪退。',
  '- 标注 label 只认字符串 `"0"/"1"/"2"/"3"`：各正解恰好一个且按题序，干扰项全标 `0`。',
  '- 未经人工审核的预标注禁止并入训练集；`merge_round.py` 不要加 `--include-pending`。',
  '- 真实指标只看 `eval_e2e.py` 的 E2E 通过率；`val_acc` 仅作收敛趋势参考。',
  '- 在线 verify 仍全 `result:fail`，瓶颈是 `w` 缺轨迹字段，别再调坐标数值格式。',
  '- 改模型 / 预处理后自己跑真实破解验证；`verify_all.sh` 只验路由不验推理。',
];

interface ExampleSection {
  heading: string;
  body: string[];
}

interface ExampleTopic {
  file: string;
  summary: string;
  /** one NEW broad title; original headings stay verbatim as ## sections */
  title: string;
  sections: ExampleSection[];
}

const EXAMPLE_TOPICS: readonly ExampleTopic[] = [
  {
    file: 'memory/status-and-roadmap.md',
    summary: '接手先读：一句话现状、本轮记录、当前阻塞与精确下一步命令',
    title: '现状与路线',
    sections: [
      { heading: '现状一句话', body: ['离线闭环已通，在线仍全 `result:fail`，阻塞在 `w` 载荷缺轨迹字段。'] },
      { heading: '本轮记录', body: ['补齐协议自检脚本，确认不是模型问题；未改训练侧代码。'] },
      { heading: '精确下一步', body: ['跑 `python tools/check_protocol.py --dump w`，把缺字段补进载荷构造，再跑一次在线 verify。'] },
    ],
  },
  {
    file: 'memory/environment.md',
    summary: '本地/服务器环境、代理与下载坑、SSH 传文件与链路验证、排查顺序',
    title: '环境与联网',
    sections: [
      { heading: '本地与服务器环境', body: ['本地 4GB 显卡只验代码路径；训练在服务器 GPU 环境，优先空闲卡。'] },
      { heading: '代理与镜像下载', body: ['下载前同时设置代理、端点与关闭 Xet 的变量，旧镜像已失效。'] },
      { heading: '传文件与链路验证', body: ['SSH 反向代理映射服务器端口；大文件用 `scp`，先 `curl -I` 再查环境变量。'] },
    ],
  },
  {
    file: 'memory/dataset-and-annotation.md',
    summary: '采集/预览、B/S 标注工具与快捷键、按题随机切定案、离线审核与合并',
    title: '数据集与标注',
    sections: [
      { heading: '采集与预览', body: ['采集脚本按题号落盘，预览工具用 B/S 切上一题 / 下一题。'] },
      { heading: '标注工具与快捷键', body: ['`1/2/3` 定正解、`0` 标干扰；按题随机切定案避免顺序偏差。'] },
      { heading: '离线审核与合并', body: ['`flags.prelabel="1"` 的样本必须人工过一遍才能 `merge_round.py`。'] },
    ],
  },
  {
    file: 'memory/models-and-code.md',
    summary: '关键技术事实、已修 bug、共享预处理模块与 v2 训练结果',
    title: '模型与代码',
    sections: [
      { heading: '模型结构', body: ['单类检测器 + 度量编码器两阶段训练，共享 `preprocess.py` 保证线上线下一致。'] },
      { heading: '已修 bug', body: ['推理时忘了复用训练侧归一化，导致离线高、在线低；已统一预处理入口。'] },
      { heading: 'v2 训练结果', body: ['离线全量匹配率进入可用区间，但端到端仍被协议卡住。'] },
    ],
  },
  {
    file: 'memory/protocol-and-online.md',
    summary: '在线 E2E 受阻：w 载荷格式、lot_number、协议自检判据与在线脚本状态',
    title: '在线协议',
    sections: [
      { heading: 'w 载荷格式', body: ['`w` 载荷缺 `appendTrack` 轨迹字段，服务端直接判 `result:fail`。'] },
      { heading: 'lot_number 与会话', body: ['`lot_number` 必须从同一会话里取，跨请求复用会静默失败。'] },
      { heading: '协议自检判据', body: ['先比对字段集合，再比对坐标格式，最后才看数值；`verify_all.sh` 不算验收。'] },
    ],
  },
  {
    file: 'memory/pitfalls.md',
    summary: '写代码前先读：标注/代码/环境/协议的踩坑速查与「别再」清单',
    title: '踩坑速查',
    sections: [
      { heading: '标注踩坑', body: ['别把预标注当金标；`--include-pending` 会污染训练集。'] },
      { heading: '代码与环境踩坑', body: ['别复制预处理实现；别信 `.bashrc` 里的旧镜像。'] },
      { heading: '「别再」清单', body: ['别调坐标数值格式碰运气、别把 `result:fail` 当模型问题；每次失败先写「现象 → 根因 → 修法 → 如何验证」。'] },
    ],
  },
];

/** Render source sections, identically in the document and inside a topic file. */
function exampleSections(sections: readonly ExampleSection[]): string[] {
  return sections.flatMap((section) => [`## ${section.heading}`, '', ...section.body, '']);
}

/** Exposed for tests: the few-shot must itself be a plan the validator accepts. */
export const MIGRATION_EXAMPLE: { document: string; plan: MigrationPlan } = {
  document: [
    ...EXAMPLE_RESIDENT,
    '',
    ...EXAMPLE_TOPICS.flatMap((topic) => exampleSections(topic.sections)),
  ].join('\n'),
  plan: {
    resident: EXAMPLE_RESIDENT,
    files: EXAMPLE_TOPICS.map((topic) => ({
      file: topic.file,
      summary: topic.summary,
      content: [`# ${topic.title}`, '', ...exampleSections(topic.sections)].join('\n'),
    })),
  },
};

/**
 * The planner brief. It intentionally carries the plugin's canonical authoring
 * guide AND a full input→output example: with only a bare "split into resident
 * + topic files" instruction, real models produced 17 one-heading files, which
 * turns the index into a table of contents instead of a "when to read" map.
 */
export const MIGRATION_SYSTEM_PROMPT = [
  'You are the ONE-SHOT migration planner for a project-memory plugin.',
  'You restructure an existing prose AGENTS.md into "resident rules + a SMALL number of lazy-loaded topic files".',
  '',
  '## 1. Read the canonical authoring guide first',
  "The guide below is the plugin's single source of truth for the two zones, their",
  'boundaries, index-line style, budgets and anti-patterns. It is REFERENCE ONLY:',
  'it is not the document to migrate, and you must not copy it into the plan.',
  'It addresses an agent that edits memory incrementally; ignore its tool actions',
  '(`list` / `append` / `add_resident` / preview / backup) — the host already owns',
  'those steps. Apply only its zone rules, boundary tests and anti-patterns.',
  '',
  '--- BEGIN AUTHORING GUIDE ---',
  projectGuideText(),
  '--- END AUTHORING GUIDE ---',
  '',
  '## 2. Coarse-topic rule (the failure mode this brief fixes)',
  `- Aim for 3-6 topic files. NEVER more than ${DEFAULT_MIGRATION_MAX_FILES}; the validator refuses more.`,
  "The guide's 'more than 5 topics' line is a maintenance smell, not a hard",
  'cap: 6 broad themes are fine when the source genuinely has that many areas',
  '(as in the worked example below). 17 one-heading files are never fine.',
  '- Do NOT create one file per original heading, per bullet or per paragraph.',
  '- Group related headings into broad, durable, retrievable themes such as:',
  '  status-and-roadmap, environment, dataset-and-annotation, models-and-code,',
  '  protocol-and-online, pitfalls, architecture, release-sop, overview.',
  '- A topic file usually contains SEVERAL original headings. Add ONE new broad',
  '  `#` title of your own, then keep every original heading line VERBATIM as a',
  '  `##` / `###` subheading inside that file. The only allowed exception is',
  '  folding a short hard-constraint section into a resident bullet that starts',
  '  with the heading text (e.g. `## 构建` -> `- 构建：npm run build`).',
  '  Never rename or flatten an original heading away: headings are checked',
  '  structurally by the validator.',
  '- `summary` is a one-line "when should an agent read this file" hint, not a',
  '  label like 杂项 / 其他 / notes / misc.',
  '- Do NOT create `memory/all.md`, `memory/notes.md` or `memory/misc.md`.',
  '- One file per topic means one file per BROAD theme, not per source section.',
  '',
  '## 3. Worked example (shape only — never copy its facts into a real plan)',
  'The prose document below has ONE resident section + EIGHTEEN short topic sections.',
  'It becomes ONE resident block + SIX broad topic files, each grouping THREE',
  'original sections under one new broad title while preserving every original',
  'heading and paragraph verbatim. Each summary says when to read the file.',
  '',
  '--- BEGIN EXAMPLE DOCUMENT ---',
  MIGRATION_EXAMPLE.document,
  '--- END EXAMPLE DOCUMENT ---',
  '',
  '--- BEGIN EXAMPLE OUTPUT ---',
  JSON.stringify(MIGRATION_EXAMPLE.plan, null, 2),
  '--- END EXAMPLE OUTPUT ---',
  '',
  '## 4. Hard rules',
  '- Resident block (top of AGENTS.md, injected into every request): keep ONLY',
  '  operational hard constraints — build/run/test commands, files that must',
  '  never be edited, startup/deployment constraints, non-negotiable coding',
  '  conventions. Everything else (architecture, history, troubleshooting,',
  '  configuration reference, API notes) goes into topic files.',
  '- Every heading and every paragraph of the original MUST appear either in the',
  '  resident block or in exactly one topic file. Moving is fine; dropping,',
  '  merging away or paraphrasing-to-nothing is not.',
  '- Preserve the original wording. Do not summarize, do not beautify.',
  '- Do not invent facts that are not in the original.',
  '- Do not include secrets, tokens, passwords, or private keys.',
  '- Resident lines are plain text lines (no leading "-" needed unless the original had one).',
  '- If the original has nothing suitable for the resident block, return an empty array for it.',
  '- Output ONLY a JSON object, no markdown fence, no commentary:',
  '{"resident":["line","line"],"files":[{"file":"memory/example.md","summary":"one line","content":"# ..."}]}',
].join('\n');

/**
 * Build the user message for one document. The guide and the worked example
 * live in the system brief; this message carries only the document to split,
 * so the model can never confuse reference text with source text.
 */
function buildPrompt(original: string): string {
  return [
    'Apply the system brief (authoring guide + coarse-topic rule + worked example) to the document below.',
    'Return ONLY the JSON object described there.',
    '',
    '--- BEGIN DOCUMENT TO MIGRATE ---',
    original,
    '--- END DOCUMENT TO MIGRATE ---',
  ].join('\n');
}

/**
 * Extract every markdown heading text from a document.
 */
export function headingsOf(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) out.push(match[1].trim());
  }
  return out;
}

/**
 * Parse the planner's JSON reply, tolerating a fenced code block.
 */
export function parsePlan(reply: string): MigrationPlan | null {
  const parsed = extractJsonObject(reply);
  if (parsed === undefined) return null;
  const obj = parsed as { resident?: unknown; files?: unknown };
  // The prompt asks for an array of lines, but models routinely answer with one
  // multi-line string. Accept both rather than failing a usable plan.
  let resident: string[];
  if (Array.isArray(obj.resident)) {
    if (obj.resident.some((line) => typeof line !== 'string')) return null;
    resident = obj.resident as string[];
  } else if (typeof obj.resident === 'string') {
    resident = obj.resident.split('\n');
  } else {
    return null;
  }
  if (!Array.isArray(obj.files)) return null;
  const files: MigrationFile[] = [];
  for (const raw of obj.files) {
    const file = raw as { file?: unknown; summary?: unknown; content?: unknown };
    if (typeof file.file !== 'string' || typeof file.content !== 'string') return null;
    files.push({
      file: file.file,
      summary: typeof file.summary === 'string' ? file.summary.trim() : '',
      content: file.content,
    });
  }
  return { resident, files };
}

/**
 * Extract the outermost JSON object from a reply.
 *
 * Topic-file content legitimately contains markdown code fences, so a naive
 * "first ``` ... next ```" split corrupts the payload. Only a fence that WRAPS
 * the whole reply is stripped; otherwise the text between the first `{` and
 * the matching last `}` is parsed directly.
 */
function extractJsonObject(reply: string): unknown {
  const trimmed = reply.trim();
  const attempts: string[] = [];
  const wrapped = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  if (wrapped) attempts.push(wrapped[1]);
  attempts.push(trimmed);
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) attempts.push(trimmed.slice(start, end + 1));
  for (const attempt of attempts) {
    const candidate = attempt.trim();
    if (!candidate.startsWith('{')) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next shape
    }
  }
  return undefined;
}

export interface ValidationOptions extends AgentsBudget {
  /** per-file character limit (0/undefined = unbounded) */
  fileCharLimit?: number;
  /** enable the secret/injection scanner */
  scan?: boolean;
  /** max number of new topic files; 0/undefined uses DEFAULT_MIGRATION_MAX_FILES */
  maxFiles?: number;
}

/**
 * Validate a plan before anything is written.
 *
 * @returns an error string, or null when the plan is safe to apply
 */
export function validatePlan(root: string, original: string, plan: MigrationPlan, opts: ValidationOptions = {}): string | null {
  if (plan.resident.length === 0 && plan.files.length === 0) return '计划为空';
  const maxFiles = opts.maxFiles || DEFAULT_MIGRATION_MAX_FILES;
  if (plan.files.length > maxFiles) {
    return `迁移计划拆出了 ${plan.files.length} 个主题文件，超过上限 ${maxFiles}：请合并成少数宽主题，不要按原文章节一一切片`;
  }
  if (opts.residentCharLimit && residentChars(plan.resident) > opts.residentCharLimit) {
    return `常驻区超预算（${residentChars(plan.resident)} > ${opts.residentCharLimit} 字符）`;
  }
  const seen = new Set<string>();
  let fileChars = 0;
  const plannedEntries: Array<{ file: string; summary: string }> = [];
  for (const file of plan.files) {
    const safe = safeMemoryRel(root, file.file);
    if (!safe) return `非法记忆文件名：${file.file}`;
    if (seen.has(safe)) return `重复的记忆文件：${safe}`;
    seen.add(safe);
    if (!file.content.trim()) return `${safe} 内容为空`;
    if (!file.summary.trim()) return `${safe} 缺少一句话索引描述（summary）`;
    if (/\b(?:all|notes|misc)\.md$/i.test(safe)) {
      return `${safe} 是典型的「什么都往里塞」文件名，请改用能说明何时该读的宽主题名`;
    }
    if (opts.fileCharLimit && file.content.length > opts.fileCharLimit) {
      return `${safe} 超过单文件上限（${file.content.length} > ${opts.fileCharLimit}）`;
    }
    if (opts.scan) {
      const blocked = scanContent(file.content) ?? scanContent(file.summary);
      if (blocked) return `${safe} 未通过内容扫描：${blocked}`;
    }
    fileChars += file.content.length;
    plannedEntries.push({ file: safe, summary: file.summary.trim() });
  }
  // Count existing index entries the host will keep, plus unindexed files it
  // will adopt after a forced re-run. Checking the plan alone used to let a
  // 17-topic plan through validatePlan() only to fail at writeAgents(), after
  // the topic files had already been written to disk.
  const existing = readIndex(root);
  const allEntries = [
    ...plannedEntries,
    ...existing.entries
      .filter((e) => !plannedEntries.some((p) => p.file === e.file))
      .map((e) => ({ file: e.file, summary: e.summary })),
    ...existing.orphans
      .filter((rel) => !plannedEntries.some((p) => p.file === rel))
      .map((rel) => ({ file: rel, summary: firstHeadingOrName(root, rel) })),
  ];
  if (opts.indexCharLimit && indexChars(allEntries) > opts.indexCharLimit) {
    return `索引区超预算（${indexChars(allEntries)} > ${opts.indexCharLimit} 字符）：请合并主题或缩短描述`;
  }
  if (opts.scan) {
    const blocked = scanContent(plan.resident.join('\n'));
    if (blocked) return `常驻区未通过内容扫描：${blocked}`;
  }

  // Heading preservation, checked STRUCTURALLY. Substring matching was not
  // enough: a plan that dumps the whole original document into one topic file
  // makes every heading "present" while the resident rules vanish. A heading
  // only counts when it appears as an actual heading line in exactly the place
  // it now lives.
  const residentText = plan.resident.join('\n');
  const fileText = plan.files.map((f) => f.content).join('\n');
  const producedSet = new Set(headingsOf(`${residentText}\n${fileText}`));
  // A heading may legitimately be folded into a resident rule or a bullet
  // (`## 构建` -> `- 构建：npm run build`). Accept either a real heading line or
  // a line that mentions it, but only when the mention carries real content.
  const missing = headingsOf(original).filter((heading) => {
    if (producedSet.has(heading)) return false;
    const asLine = new RegExp(`^\\s*(?:[-*+]\\s+|\\d+\\.\\s+)?${escapeRegExp(heading)}`, 'm');
    return !(asLine.test(residentText) || asLine.test(fileText));
  });
  if (missing.length > 0) {
    return `迁移会丢失 ${missing.length} 个标题：${missing.slice(0, 5).map((h) => `「${h}」`).join('、')}`;
  }
  // A topic file that reproduces the original verbatim means the plan did not
  // actually split anything — the resident rules would be demoted to lazy text.
  const body = [plan.resident.join('\n'), ...plan.files.map((f) => f.content)].join('\n');
  const originalHeadings = headingsOf(original).length;
  if (plan.resident.length === 0 && originalHeadings > 0) {
    return '迁移计划的常驻区为空，原文的规则会被整体降级为懒加载内容';
  }
  const trimmedOriginal = original.trim();
  for (const file of plan.files) {
    // Verbatim copy, or a single topic file carrying nearly all of the original
    // body, means the plan did not split anything — the "headings are present"
    // check would otherwise pass while the resident rules were demoted to a
    // lazily-loaded file.
    const carriesAll = file.content.includes(trimmedOriginal)
      || (trimmedOriginal.length > 0 && file.content.length >= trimmedOriginal.length * 0.9 && plan.files.length === 1);
    if (carriesAll) return `${file.file} 原样包含了几乎整份原文，说明没有真正拆分`;
  }
  if (body.length < original.length * 0.8) {
    return `迁移结果明显短于原文（${body.length} < ${Math.round(original.length * 0.8)} 字符），可能丢失内容`;
  }
  return null;
}

/** Mirrors the on-disk name of the pre-migration copy. */
function backupName(): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `AGENTS.md.bak-${stamp}`;
}

/**
 * Plan and (optionally) apply a migration for one project.
 *
 * @param apply false = plan only, so the admin page can preview it
 * @param force re-run even when the file already looks migrated
 */
export async function migrateAgents(
  ctx: Context,
  root: string,
  route: LlmRoute | undefined,
  opts: ValidationOptions & {
    apply?: boolean;
    timeoutMs?: number;
    force?: boolean;
    /** Progress reporter for the long LLM call; the admin page polls it. */
    onProgress?: MigrationProgressFn;
    /** override the planner call (tests inject a fixture; production uses callLlm) */
    plan?: (prompt: string) => Promise<string>;
  } = {},
): Promise<MigrationResult> {
  const report = (stage: MigrationStage, detail?: string): void => {
    try { opts.onProgress?.({ stage, detail }); } catch { /* reporting is best-effort */ }
  };
  const refuse = (reason: string, plan?: MigrationPlan): MigrationResult => {
    report('refused', reason);
    return { migrated: false, reason, plan };
  };
  const fail = (reason: string, plan?: MigrationPlan): MigrationResult => {
    report('failed', reason);
    return { migrated: false, reason, plan };
  };

  report('starting');
  report('checking');
  const index = readIndex(root);
  if (!index.exists) return refuse('AGENTS.md 不存在');
  if (index.resident.length === 0 && !opts.force) {
    return refuse('AGENTS.md 已经是纯索引形态，无需迁移');
  }
  // Migration is a ONE-SHOT transformation of a prose document. A file that
  // already carries index entries has been migrated: its remaining body text
  // is the resident block the author wants kept, and the planner only ever
  // sees that body. Re-running would replace the whole index with entries for
  // those few resident rules and orphan every existing topic file.
  if (index.entries.length > 0 && !opts.force) {
    return refuse(`AGENTS.md 已有 ${index.entries.length} 条 @memory/ 索引，属于迁移后形态；常驻区如需继续拆分请手动编辑（迁移只处理纯散文文档）`);
  }
  if (!route) {
    return refuse('还没有可用的模型路由：请在 profile 的 cordis.patch.yml 里配置 agent-default-model 的 provider/model');
  }

  const original = index.resident.join('\n');
  if (!original.trim()) return refuse('没有可迁移的内容');

  const timeoutMs = opts.timeoutMs ?? DEFAULT_MIGRATION_TIMEOUT_MS;
  const timeoutLabel = timeoutMs >= 60_000
    ? `${Math.round(timeoutMs / 60_000)} 分钟`
    : `${Math.round(timeoutMs / 1000)} 秒`;
  report('planning', `调用 ${route.provider}/${route.model} 规划拆分（最长 ${timeoutLabel}）`);
  let reply: string;
  try {
    reply = opts.plan
      ? await opts.plan(buildPrompt(original))
      : await callLlm(ctx, route, MIGRATION_SYSTEM_PROMPT, buildPrompt(original), timeoutMs);
  } catch (err) {
    return fail(`调用模型失败：${(err as Error | undefined)?.message ?? String(err)}`);
  }
  const plan = parsePlan(reply);
  if (!plan) return fail('模型返回的计划无法解析');
  report('validating', '校验标题保全、主题粒度、内容扫描、路径与字符预算');
  const invalid = validatePlan(root, original, plan, opts);
  if (invalid) return refuse(invalid, plan);
  if (opts.apply === false) return refuse('preview', plan);

  report('writing', `写入 ${plan.files.length} 个主题文件并更新 AGENTS.md 索引`);
  // Keep a copy of the pre-migration file: an LLM rewrite must never be the
  // only record of the author's original rules.
  const backup = backupName();
  try {
    fs.writeFileSync(`${root}/${backup}`, index.resident.join('\n').trim() + '\n', 'utf8');
  } catch {
    /* backup is best-effort; the plan itself was validated */
  }

  const written: string[] = [];
  for (const file of plan.files) {
    const result = await writeMemoryFile(root, file.file, file.content, opts.fileCharLimit);
    if (!result.ok) return fail(result.error, plan);
    written.push(result.file);
  }
  // Normalize planned paths BEFORE comparing with existing entries: the model
  // may answer `memory/x.md`, `x.md` or `./memory/x.md` for the same file.
  const planned = plan.files
    .map((f) => ({ file: safeMemoryRel(root, f.file) ?? f.file, summary: f.summary, exists: true, chars: f.content.length }));
  const plannedFiles = new Set(planned.map((e) => e.file));
  // Keep pre-existing entries the plan did not mention, so a run can never
  // silently unindex a topic file that is still on disk...
  const survivors = readIndex(root).entries.filter((e) => !plannedFiles.has(e.file));
  // ...and adopt files already in memory/ that were never indexed (a repo can
  // follow the convention by hand before this plugin ever runs).
  const adopted: Array<{ file: string; summary: string; exists: true; chars: number }> = [];
  for (const rel of listMemoryFiles(root)) {
    if (plannedFiles.has(rel)) continue;
    if (survivors.some((e) => e.file === rel)) continue;
    adopted.push({ file: rel, summary: firstHeadingOrName(root, rel), exists: true, chars: readMemoryFile(root, rel)?.length ?? 0 });
  }
  const entries = [...planned, ...survivors, ...adopted];
  const wrote = await writeAgents(root, plan.resident, entries, {
    residentCharLimit: opts.residentCharLimit,
    indexCharLimit: opts.indexCharLimit,
  });
  if (!wrote.ok) return fail(wrote.error, plan);
  report('completed', `新建 ${written.length} 个主题文件，原文备份为 ${backup}`);
  return { migrated: true, plan, written, backup };
}

/**
 * First `# heading` of a topic file, used as its index summary when adopting a
 * file the plan did not mention. Falls back to the file's basename.
 */
/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function firstHeadingOrName(root: string, rel: string): string {
  const text = readMemoryFile(root, rel) ?? '';
  const heading = /^#{1,6}\s+(.+)$/m.exec(text);
  if (heading) return heading[1].trim().slice(0, 120);
  return rel.replace(/^memory\//, '').replace(/\.md$/, '').replace(/[-_]/g, ' ');
}
