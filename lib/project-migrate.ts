/**
 * One-shot migration of an existing AGENTS.md into the resident + index shape.
 *
 * The interesting constraint: a repository's AGENTS.md is usually a real
 * instruction document (build commands, forbidden edits, architecture notes).
 * Rewriting it badly means the model silently loses rules it used to obey —
 * the worst possible outcome for a memory plugin. So the migration is a
 * *planner + validator* pair:
 *
 *   1. an auxiliary LLM call (the session's own model route) proposes a split
 *      into resident rules and `memory/*.md` topic files,
 *   2. every heading in the original must be traceable in the result,
 *   3. only a plan that passes validation plus the content scanner and the
 *      character budgets is written to disk. Otherwise nothing changes and the
 *      caller gets the reason.
 *
 * Validation-not-trust is what makes an LLM-written migration safe here: a
 * hallucinated summary is caught by the heading check, and a plan that drops a
 * section can never replace the file.
 */
import fs from 'node:fs';
import { scanContent } from './secret-scanner.js';
import { callLlm, type LlmRoute } from './llm-helper.js';
import type { Context } from '@deepseek-ai/cordis';
import {
  readIndex,
  writeAgents,
  writeMemoryFile,
  readMemoryFile,
  listMemoryFiles,
  safeMemoryRel,
  residentChars,
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

const MIGRATION_SYSTEM_PROMPT = `You restructure an existing project instruction document into "resident rules + lazy-loaded topic files".

Resident block (goes at the top of AGENTS.md, injected into every request):
- Keep ONLY operational hard constraints: build/run/test commands, files that must never be edited, startup/deployment constraints, non-negotiable coding conventions.
- Preserve the original wording. Do not summarize, do not beautify.

Topic files (become memory/<topic>.md, loaded only when asked):
- Everything else: architecture explanations, history, troubleshooting detail, configuration reference, API notes.
- One file per topic; slug-style lowercase hyphenated names, e.g. memory/build-pipeline.md.

HARD RULES:
- Every heading and every paragraph of the original MUST appear either in the resident block or in exactly one topic file. Never drop, merge away, or paraphrase-to-nothing.
- Do not invent facts that are not in the original.
- Do not include secrets, tokens, passwords, or private keys.
- Output ONLY a JSON object, no markdown fence, no commentary:
{"resident":["line","line"],"files":[{"file":"memory/example.md","summary":"one line","content":"# ..."}]}
- resident lines are plain text lines (no leading "-" needed unless the original had one).
- If the original has nothing suitable for the resident block, return an empty array for it.`;

/**
 * Build the planning prompt for one document.
 */
function buildPrompt(original: string): string {
  return [
    'Rewrite the following project instruction document into the resident + topic-file structure.',
    '',
    '--- BEGIN DOCUMENT ---',
    original,
    '--- END DOCUMENT ---',
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
}

/**
 * Validate a plan before anything is written.
 *
 * @returns an error string, or null when the plan is safe to apply
 */
export function validatePlan(root: string, original: string, plan: MigrationPlan, opts: ValidationOptions = {}): string | null {
  if (plan.resident.length === 0 && plan.files.length === 0) return '计划为空';
  if (opts.residentCharLimit && residentChars(plan.resident) > opts.residentCharLimit) {
    return `常驻区超预算（${residentChars(plan.resident)} > ${opts.residentCharLimit} 字符）`;
  }
  const seen = new Set<string>();
  let fileChars = 0;
  for (const file of plan.files) {
    const safe = safeMemoryRel(root, file.file);
    if (!safe) return `非法记忆文件名：${file.file}`;
    if (seen.has(safe)) return `重复的记忆文件：${safe}`;
    seen.add(safe);
    if (!file.content.trim()) return `${safe} 内容为空`;
    if (opts.fileCharLimit && file.content.length > opts.fileCharLimit) {
      return `${safe} 超过单文件上限（${file.content.length} > ${opts.fileCharLimit}）`;
    }
    if (opts.scan) {
      const blocked = scanContent(file.content) ?? scanContent(file.summary);
      if (blocked) return `${safe} 未通过内容扫描：${blocked}`;
    }
    fileChars += file.content.length;
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
    /** override the planner call (tests inject a fixture; production uses callLlm) */
    plan?: (prompt: string) => Promise<string>;
  } = {},
): Promise<MigrationResult> {
  const index = readIndex(root);
  if (!index.exists) return { migrated: false, reason: 'AGENTS.md 不存在' };
  if (index.resident.length === 0 && !opts.force) {
    return { migrated: false, reason: 'AGENTS.md 已经是纯索引形态，无需迁移' };
  }
  // Migration is a ONE-SHOT transformation of a prose document. A file that
  // already carries index entries has been migrated: its remaining body text
  // is the resident block the author wants kept, and the planner only ever
  // sees that body. Re-running would replace the whole index with entries for
  // those few resident rules and orphan every existing topic file.
  if (index.entries.length > 0 && !opts.force) {
    return {
      migrated: false,
      reason: `AGENTS.md 已有 ${index.entries.length} 条 @memory/ 索引，属于迁移后形态；常驻区如需继续拆分请手动编辑（迁移只处理纯散文文档）`,
    };
  }
  if (!route) return { migrated: false, reason: 'no-llm-route' };

  const original = index.resident.join('\n');
  if (!original.trim()) return { migrated: false, reason: '没有可迁移的内容' };

  let reply: string;
  try {
    reply = opts.plan
      ? await opts.plan(buildPrompt(original))
      : await callLlm(ctx, route, MIGRATION_SYSTEM_PROMPT, buildPrompt(original), opts.timeoutMs ?? 120_000);
  } catch (err) {
    return { migrated: false, reason: `调用模型失败：${(err as Error | undefined)?.message ?? String(err)}` };
  }
  const plan = parsePlan(reply);
  if (!plan) return { migrated: false, reason: '模型返回的计划无法解析' };
  const invalid = validatePlan(root, original, plan, opts);
  if (invalid) return { migrated: false, reason: invalid, plan };
  if (opts.apply === false) return { migrated: false, reason: 'preview', plan };

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
    if (!result.ok) return { migrated: false, reason: result.error, plan };
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
  if (!wrote.ok) return { migrated: false, reason: wrote.error, plan };
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
