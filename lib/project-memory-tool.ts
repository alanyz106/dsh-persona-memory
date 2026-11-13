/**
 * The `project_memory` tool — per-repository memory in the resident + index
 * shape.
 *
 * Scope is deliberately implicit: the project is whatever repository the
 * session is working in. There is no `project` argument, because a model that
 * can name arbitrary projects can also write arbitrary paths, and the payoff
 * (editing repository B's notes from repository A) does not justify that.
 *
 * The index in AGENTS.md is the contract. Every mutation keeps it in sync:
 * `write`/`append` ensure a pointer line exists, `delete` removes it, and the
 * resident block is edited through `add_resident`/`remove_resident` or the
 * line-level `update`.
 */
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { scanContent } from './secret-scanner.js';
import { resolveLlmRoute, latestRoute, type LlmRoute } from './llm-helper.js';
import { migrateAgents } from './project-migrate.js';
import { projectGuideText } from './project-guide.js';
import { registerProject } from './project-registry.js';
import {
  readIndex,
  readMemoryFile,
  writeMemoryFile,
  appendMemoryFile,
  updateMemoryFile,
  deleteMemoryFile,
  mutateIndex,
  searchMemoryFiles,
  resolveProjectRoot,
  safeMemoryRel,
  residentChars,
  indexChars,
  type ProjectIndex,
} from './project-memory.js';
import type { JsonValue } from './json-value.js';
import type { Context } from '@deepseek-ai/cordis';

/**
 * One line per mutating project-memory call — same audit purpose as the
 * global `memory` tool's logWrite. `file` is empty for resident/index-wide
 * actions; `detail` carries the target or outcome.
 */
function logProjectWrite(ctx: Context, exec: ToolRunContext | undefined, action: string, root: string, file: string, detail: string): void {
  const sessionId = (exec as { agent?: { id?: string } } | undefined)?.agent?.id ?? 'unknown-session';
  const short = root.split('/').pop() ?? root;
  ctx.logger.info(
    '[dsh-persona-memory] project_memory %s %s %s %s: %s',
    action,
    short,
    sessionId,
    file || '-',
    detail.replace(/\s+/g, ' ').slice(0, 80),
  );
}

export interface ProjectMemoryToolConfig {
  projectFileCharLimit: number;
  projectResidentCharLimit: number;
  projectIndexCharLimit: number;
  projectAutoMigrate: boolean;
  projectMigrateTimeoutMs: number;
  enableSecretScanning: boolean;
  searchMaxResults: number;
  /** where project-registry.json lives */
  memoryDir: string;
}

/** Services and config the tool needs. */
export interface ProjectMemoryDeps {
  config: ProjectMemoryToolConfig;
  /** @returns the session's working directory, or null */
  cwdOf: (exec: ToolRunContext) => string | null;
  /** called after a successful write so the host can refresh caches */
  onWrite?: (root: string) => void;
}

/**
 * Resolve + validate the project for one tool run.
 *
 * @throws HarnessError when the session has no project directory
 */
function projectFor(exec: ToolRunContext, deps: ProjectMemoryDeps): { root: string; index: ProjectIndex } {
  const cwd = deps.cwdOf(exec);
  if (!cwd) {
    throw new HarnessError('当前会话没有工作目录，无法定位项目记忆。', 'PROJECT_NO_CWD');
  }
  const root = resolveProjectRoot(cwd);
  if (!root) {
    throw new HarnessError('当前工作目录不是项目（家目录/根目录），请使用全局 `memory` 工具。', 'PROJECT_NOT_A_PROJECT');
  }
  return { root, index: readIndex(root) };
}

/** Declared parameter names — anything else in `args` is a model mistake. */
const DECLARED_PARAMS = ['action', 'file', 'summary', 'content', 'match', 'query', 'apply'] as const;
type DeclaredParam = typeof DECLARED_PARAMS[number];

/**
 * Names a model reaches for instead of `file`.
 *
 * The harness's own `read`/`write`/`edit` tools all take `file_path`, so a
 * model switching tools carries the name over. The parameter schema is open
 * (only `action` is required), so nothing rejected it: the action then read
 * `args.file` as `undefined` and reported `非法记忆文件名：undefined`, which
 * names neither the offending key nor the fix.
 */
const FILE_ALIASES = ['file_path', 'path', 'filepath'] as const;

/** Per-action arguments that must be non-empty strings, with a usage hint. */
const ACTION_REQUIREMENTS: Readonly<Record<string, readonly { field: RequiredField; hint: string }[]>> = {
  read: [{ field: 'file', hint: '形如 memory/build.md' }],
  write: [
    { field: 'file', hint: '形如 memory/build.md' },
    { field: 'summary', hint: '写进 AGENTS.md 索引行的一句话摘要' },
    { field: 'content', hint: '主题文件的完整正文' },
  ],
  append: [
    { field: 'file', hint: '形如 memory/pitfalls.md' },
    { field: 'content', hint: '要追加的小节，不会覆盖原文件' },
  ],
  delete: [{ field: 'file', hint: '形如 memory/build.md' }],
  update: [
    { field: 'match', hint: '要替换的那一行里的唯一子串' },
    { field: 'content', hint: '替换后的新内容' },
  ],
  search: [{ field: 'query', hint: '空格分隔的检索词' }],
  add_resident: [{ field: 'content', hint: '加入常驻区的规则行，一行一条' }],
  remove_resident: [{ field: 'match', hint: '要删除的常驻行里的唯一子串' }],
};

type RequiredField = 'file' | 'summary' | 'content' | 'match' | 'query';
/** Every string argument of one call; empty when the action does not need it. */
type ActionArgs = Record<RequiredField, string>;

/**
 * Rewrite one call's arguments into the declared names, or reject it.
 *
 * @throws HarnessError when the call carries a parameter this tool does not have
 */
function normalizeArgs(raw: Record<string, unknown>, ctx: Context): Record<string, unknown> {
  const args: Record<string, unknown> = { ...raw };
  for (const alias of FILE_ALIASES) {
    if (!Object.hasOwn(args, alias)) continue;
    const aliased = args[alias];
    delete args[alias];
    if (typeof args.file === 'string' && args.file.trim() !== '') {
      if (args.file !== aliased) {
        ctx.logger.warn('[dsh-persona-memory] project_memory: 同时给了 `file` 和 `%s`，以 `file` 为准', alias);
      }
      continue;
    }
    args.file = aliased;
    ctx.logger.warn('[dsh-persona-memory] project_memory: 参数 `%s` 按 `file` 处理（命名沿用自 fs 工具）', alias);
  }
  const unknown = Object.keys(args).filter((key) => !DECLARED_PARAMS.includes(key as DeclaredParam));
  if (unknown.length > 0) {
    throw new HarnessError(
      `project_memory 不认识参数 ${unknown.map((key) => `\`${key}\``).join('、')}；`
      + `可用参数只有 ${DECLARED_PARAMS.join('/')}（文件名用 \`file\`，形如 memory/build.md）`,
      'PROJECT_UNKNOWN_ARGUMENT',
    );
  }
  if (typeof args.action !== 'string' || args.action.trim() === '') {
    throw new HarnessError('project_memory 缺少必填参数 `action`', 'PROJECT_MISSING_ARGUMENT');
  }
  return args;
}

/**
 * Validate the required arguments of one action before any filesystem work.
 *
 * The declared schema cannot express per-action dependencies (only `action` is
 * required), so this is where a missing `file`/`content`/`match` is caught —
 * with a message naming the field and its shape, instead of letting the action
 * read `undefined` and fail later on a path gate.
 *
 * @returns every string argument, empty for the ones this action does not use
 */
function requireActionArgs(args: Record<string, unknown>, action: string): ActionArgs {
  const req: ActionArgs = { file: '', summary: '', content: '', match: '', query: '' };
  for (const { field, hint } of ACTION_REQUIREMENTS[action] ?? []) {
    const value = args[field];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new HarnessError(
        `project_memory ${action} 缺少必填参数 \`${field}\`（${hint}）`,
        'PROJECT_MISSING_ARGUMENT',
      );
    }
    req[field] = value;
  }
  // `update` takes an optional `file` to choose the zone; every other action
  // either requires it above or ignores it.
  if (req.file === '' && typeof args.file === 'string') req.file = args.file;
  return req;
}

/**
 * Validate one `file` argument and explain a rejection in what the model
 * actually passed.
 *
 * `safeMemoryRel` stays the only gate; this turns its `null` into a message
 * that names the mistake — a body pasted into `file`, an absolute path, a
 * non-markdown name, or AGENTS.md itself.
 *
 * @throws HarnessError when the value is not a legal project memory path
 */
function requireRel(root: string, value: unknown, action: string): string {
  // A bare `AGENTS.md` is the one input `safeMemoryRel` rewrites into a
  // plausible-looking-but-wrong path: the shorthand rule prepends `memory/`,
  // so the call fails much later with `memory/AGENTS.md 不存在`. The model meant
  // the resident zone, which no topic-file action can address.
  if (typeof value === 'string' && !value.includes('/') && !value.includes('\\')
    && value.trim().toLowerCase() === 'agents.md') {
    throw new HarnessError(
      `project_memory ${action}：\`AGENTS.md\` 是常驻区本身，不是 memory/ 下的主题文件。`
      + '改常驻规则用 `update`（配 `match`+`content`）/`add_resident`/`remove_resident`；'
      + '主题文件形如 `memory/build.md`',
      'PROJECT_INVALID_FILE',
    );
  }
  const rel = safeMemoryRel(root, value);
  if (rel !== null) return rel;
  throw new HarnessError(
    `project_memory ${action}：${describeBadFile(value)}`,
    'PROJECT_INVALID_FILE',
  );
}

function describeBadFile(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    return '缺少必填参数 `file`（形如 memory/build.md）';
  }
  const raw = value.trim();
  const slashed = raw.replace(/\\/g, '/');
  if (raw.includes('\n') || raw.length > 200) {
    return '`file` 看起来是正文而不是路径——正文放 `content`，`file` 只写 `memory/<主题>.md`';
  }
  if (/(^|\/)AGENTS\.md$/i.test(slashed)) {
    return '`AGENTS.md` 是常驻区本身，不是主题文件：改常驻规则用 `update`/`add_resident`/`remove_resident`，主题文件形如 `memory/build.md`';
  }
  if (/^[A-Za-z]:/.test(raw) || slashed.startsWith('/') || raw.includes('..')) {
    return `\`${raw}\` 必须是项目内的相对路径（不接受绝对路径与 \`..\`），形如 memory/build.md`;
  }
  if (!slashed.endsWith('.md')) {
    return `\`${raw}\` 必须以 .md 结尾，形如 memory/build.md`;
  }
  return `\`${raw}\` 不在 memory/ 下或含有非法字符；只接受 memory/<主题>.md，或裸文件名 <主题>.md`;
}

function rejectBlocked(content: string, enabled: boolean): void {
  if (!enabled) return;
  const blocked = scanContent(content);
  if (blocked) throw new HarnessError(`项目记忆写入被拒绝：${blocked}`, 'PROJECT_CONTENT_BLOCKED');
}

/** Summary of the index for the model (bounded, no file contents). */
function describe(root: string, index: ProjectIndex, cfg: ProjectMemoryToolConfig): Record<string, JsonValue> {
  return {
    root,
    agentsFile: index.agentsFile,
    exists: index.exists,
    resident: {
      lines: index.resident.length,
      chars: residentChars(index.resident),
      limit: cfg.projectResidentCharLimit,
      content: index.resident.join('\n'),
    },
    index: {
      chars: indexChars(index.entries),
      limit: cfg.projectIndexCharLimit,
    },
    entries: index.entries.map((e) => ({ file: e.file, summary: e.summary, exists: e.exists, chars: e.chars })),
    orphans: index.orphans,
    fileCharLimit: cfg.projectFileCharLimit,
  } as unknown as Record<string, JsonValue>;
}

function formatResult(value: unknown): string {
  return '```json\n' + JSON.stringify(value, null, 2) + '\n```';
}

export function registerProjectMemoryTool(ctx: Context, deps: ProjectMemoryDeps): void {
  const cfg = deps.config;
  const budget = {
    residentCharLimit: cfg.projectResidentCharLimit,
    indexCharLimit: cfg.projectIndexCharLimit,
  };

  /** Run the auto-migration once per project when AGENTS.md is still prose. */
  const migrated = new Set<string>();
  const autoMigrate = async (root: string, index: ProjectIndex, route: LlmRoute | undefined): Promise<void> => {
    if (!cfg.projectAutoMigrate || migrated.has(root)) return;
    if (!index.exists || index.resident.length === 0) return;
    migrated.add(root);
    const result = await migrateAgents(ctx, root, route, {
      apply: true,
      scan: cfg.enableSecretScanning,
      fileCharLimit: cfg.projectFileCharLimit,
      residentCharLimit: cfg.projectResidentCharLimit,
      indexCharLimit: cfg.projectIndexCharLimit,
      timeoutMs: cfg.projectMigrateTimeoutMs,
    });
    if (result.migrated) {
      ctx.logger.info('[dsh-persona-memory] migrated AGENTS.md for %s', root);
      deps.onWrite?.(root);
    } else {
      ctx.logger.warn('[dsh-persona-memory] AGENTS.md migration skipped for %s: %s', root, result.reason ?? 'unknown');
    }
  };

  ctx.tools.register(
    defineTool({
      name: 'project_memory',
      description:
        'Manage THIS repository\'s long-term memory. It has two zones: '
        + '`AGENTS.md` (always loaded into context — its non-pointer lines are the resident zone of hard, must-not-break rules; '
        + 'its `@memory/*.md` lines index topic files) and a `memory/` directory of one-topic-per-file notes that are NOT loaded until read. '
        + 'Use this instead of the global `memory` tool for anything specific to this codebase: architecture, build/deploy steps, '
        + 'gotchas, decisions, environment quirks. '
        + 'Actions: list (index + orphans + budget usage), read (load one topic file), write (create/replace a topic file and index it), '
        + 'append (add a section to a topic file), update (replace one line matched by substring — in a topic file when `file` is given, else in the resident zone), '
        + 'delete (remove a pointer and trash its file), '
        + 'search (substring search across topic files), add_resident / remove_resident (edit the always-on rules), '
        + 'migrate (convert a prose AGENTS.md into this shape), guide (full authoring guide: what belongs in each zone, examples, anti-patterns). '
        + 'Rule of thumb: what you must not get wrong goes resident; what you look up while doing the work goes in a topic file. '
        + 'Prefer several small topic files over one big one; never store credentials (writes are scanned).',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'read', 'write', 'append', 'update', 'delete', 'search', 'add_resident', 'remove_resident', 'migrate', 'guide'],
          description: 'What to do. `guide` takes no other argument.',
        },
        file: {
          type: 'string',
          description: 'Topic file, e.g. `memory/build.md` or `build.md`. Required for read/write/append/update/delete. '
            + 'The path always goes in `file` — this tool has no `file_path`.',
        },
        summary: {
          type: 'string',
          description: 'One-line description written into the AGENTS.md index line (required for write).',
        },
        content: {
          type: 'string',
          description: 'Full file content for write, appended section for append, replacement line(s) for update, rule line(s) for add_resident. '
            + 'Never put the path here.',
        },
        match: {
          type: 'string',
          description: 'Substring locating the entry to update or delete (case-insensitive, first match wins) — resident line for remove_resident / update without `file`, line in the topic file for update with `file`.',
        },
        query: {
          type: 'string',
          description: 'Search terms (search). Every whitespace-separated term must match.',
        },
        apply: {
          type: 'boolean',
          description: 'For migrate: true writes the plan, false/omitted only previews it.',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(rawArgs, value) {
          // The guide is prose for the model to read, not a value to parse —
          // JSON-wrapping it would only add escapes to every code fence.
          if ((rawArgs as { action?: unknown } | null)?.action === 'guide') {
            const guide = (value as { guide?: unknown }).guide;
            return [{ type: 'text', text: typeof guide === 'string' ? guide : formatResult(value) }];
          }
          return [{ type: 'text', text: formatResult(value) }];
        },
      },
      async execute(args, exec) {
        // The declared schema only marks `action` required, so argument
        // hygiene is this tool's job: map the fs-style `file_path` spelling,
        // reject undeclared keys, and enforce each action's own requirements
        // before anything touches the filesystem.
        const normalized = normalizeArgs(args as unknown as Record<string, unknown>, ctx);
        const action = normalized.action as string;
        const req = requireActionArgs(normalized, action);

        // `guide` is pure documentation: it must work outside a project too
        // (a session in the home directory still needs to know how to write
        // memory), and it must not enroll the cwd in the registry — the admin
        // page lists projects that keep memory, not projects that were asked
        // about it.
        if (action === 'guide') {
          return { guide: projectGuideText() } as unknown as Record<string, JsonValue>;
        }
        const { root, index } = projectFor(exec, deps);
        registerProject(cfg.memoryDir, root);
        const route = resolveLlmRoute(ctx, exec.agent?.session ? latestRoute(exec.agent.session) : undefined);

        switch (action) {
          case 'list':
            return describe(root, index, cfg) as unknown as Record<string, JsonValue>;

          case 'read': {
            const rel = requireRel(root, req.file, 'read');
            const content = readMemoryFile(root, rel);
            if (content === null) {
              return { file: rel, exists: false } as unknown as Record<string, JsonValue>;
            }
            return { file: rel, exists: true, chars: content.length, content } as unknown as Record<string, JsonValue>;
          }

          case 'write': {
            const rel = requireRel(root, req.file, 'write');
            const summary = req.summary.trim();
            const content = req.content;
            rejectBlocked(content, cfg.enableSecretScanning);
            rejectBlocked(summary, cfg.enableSecretScanning);
            await autoMigrate(root, index, route);
            const wrote = await writeMemoryFile(root, rel, content, cfg.projectFileCharLimit);
            if (!wrote.ok) throw new HarnessError(wrote.error, 'PROJECT_WRITE_FAILED');
            const indexed = await upsertIndex(root, rel, summary, budget);
            if (!indexed.ok) throw new HarnessError(indexed.error, 'PROJECT_INDEX_FAILED');
            deps.onWrite?.(root);
            logProjectWrite(ctx, exec, 'write', root, rel, `chars=${wrote.chars} summary=${summary}`);
            return {
              file: rel,
              chars: wrote.chars,
              indexed: true,
              limit: cfg.projectFileCharLimit,
            } as unknown as Record<string, JsonValue>;
          }

          case 'append': {
            const rel = requireRel(root, req.file, 'append');
            const content = req.content;
            rejectBlocked(content, cfg.enableSecretScanning);
            await autoMigrate(root, index, route);
            const appended = await appendMemoryFile(root, rel, content, cfg.projectFileCharLimit);
            if (!appended.ok) throw new HarnessError(appended.error, 'PROJECT_WRITE_FAILED');
            const summary = typeof normalized.summary === 'string' ? normalized.summary.trim() : '';
            const existing = readIndex(root).entries.find((e) => e.file === rel);
            if (!existing || (summary && summary !== existing.summary)) {
              const indexed = await upsertIndex(root, rel, summary || existing?.summary || '', budget);
              if (!indexed.ok) throw new HarnessError(indexed.error, 'PROJECT_INDEX_FAILED');
            }
            deps.onWrite?.(root);
            logProjectWrite(ctx, exec, 'append', root, rel, `chars=${appended.chars}`);
            return { file: rel, chars: appended.chars, limit: cfg.projectFileCharLimit } as unknown as Record<string, JsonValue>;
          }

          case 'update': {
            // One action for both zones: with `file` it edits a line inside a
            // topic file; without it, a resident AGENTS.md rule. This replaces
            // the remove_resident + add_resident two-step for stale rules.
            const match = req.match;
            const content = req.content;
            rejectBlocked(content, cfg.enableSecretScanning);
            await autoMigrate(root, index, route);
            if (req.file !== '') {
              const rel = requireRel(root, req.file, 'update');
              const updated = await updateMemoryFile(root, rel, match, content, cfg.projectFileCharLimit);
              if (!updated.ok) throw new HarnessError(updated.error, 'PROJECT_UPDATE_FAILED');
              deps.onWrite?.(root);
              logProjectWrite(ctx, exec, 'update', root, rel, `${match} -> ${content}`);
              return { file: rel, chars: updated.chars } as unknown as Record<string, JsonValue>;
            }
            let replaced = 0;
            const result = await mutateIndex(root, ({ resident, entries }) => {
              const next = resident.map((line) => {
                if (replaced === 0 && line.toLowerCase().includes(match.toLowerCase())) {
                  replaced++;
                  return content.replace(/\r\n/g, '\n');
                }
                return line;
              });
              if (replaced === 0) {
                return {
                  error: `没有匹配「${match}」的常驻行。`
                    + '`update` 没给 `file` 时只改 AGENTS.md 常驻区；'
                    + '要改主题文件请带上 `file`（如 memory/pitfalls.md），要新增主题文件用 `write`',
                };
              }
              return { resident: next, entries };
            }, budget);
            if (!result.ok) throw new HarnessError(result.error, 'PROJECT_RESIDENT_UPDATE_FAILED');
            deps.onWrite?.(root);
            logProjectWrite(ctx, exec, 'update', root, '', `${match} -> ${content}`);
            return { replaced, chars: residentChars(readIndex(root).resident) } as unknown as Record<string, JsonValue>;
          }

          case 'delete': {
            const rel = requireRel(root, req.file, 'delete');
            const removed = await deleteMemoryFile(root, rel);
            const cleared = await mutateIndex(root, ({ resident, entries }) => ({
              resident,
              entries: entries.filter((e) => e.file !== rel),
            }), budget);
            deps.onWrite?.(root);
            if (!removed.ok && !cleared.ok) throw new HarnessError(removed.error, 'PROJECT_DELETE_FAILED');
            if (!cleared.ok) throw new HarnessError(cleared.error, 'PROJECT_INDEX_FAILED');
            logProjectWrite(ctx, exec, 'delete', root, rel, removed.ok ? `trashed=${removed.trashed}` : 'not-found');
            return {
              file: rel,
              deleted: removed.ok,
              trashed: removed.ok ? removed.trashed : undefined,
            } as unknown as Record<string, JsonValue>;
          }

          case 'search': {
            const query = req.query;
            const hits = searchMemoryFiles(root, query, cfg.searchMaxResults);
            return { query, matchCount: hits.length, hits } as unknown as Record<string, JsonValue>;
          }

          case 'add_resident': {
            const content = req.content;
            rejectBlocked(content, cfg.enableSecretScanning);
            const lines = content.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '');
            const result = await mutateIndex(root, ({ resident, entries }) => {
              const next = [...resident];
              for (const line of lines) {
                if (!next.some((existing) => existing.trim() === line.trim())) next.push(line);
              }
              if (residentChars(next) > cfg.projectResidentCharLimit) {
                return { error: `常驻区超预算（${residentChars(next)} > ${cfg.projectResidentCharLimit} 字符）：细节请写进 memory/ 主题文件` };
              }
              return { resident: next, entries };
            }, budget);
            if (!result.ok) throw new HarnessError(result.error, 'PROJECT_RESIDENT_FULL');
            deps.onWrite?.(root);
            logProjectWrite(ctx, exec, 'add_resident', root, '', `${lines.length} line(s): ${lines[0] ?? ''}`);
            return { added: lines.length, chars: residentChars(readIndex(root).resident) } as unknown as Record<string, JsonValue>;
          }

          case 'remove_resident': {
            const match = req.match.toLowerCase();
            let removed = 0;
            const result = await mutateIndex(root, ({ resident, entries }) => {
              const next = resident.filter((line) => {
                if (removed === 0 && line.toLowerCase().includes(match)) {
                  removed++;
                  return false;
                }
                return true;
              });
              if (removed === 0) return { error: `没有匹配「${req.match}」的常驻行` };
              return { resident: next, entries };
            }, budget);
            if (!result.ok) throw new HarnessError(result.error, 'PROJECT_RESIDENT_NOT_FOUND');
            deps.onWrite?.(root);
            logProjectWrite(ctx, exec, 'remove_resident', root, '', `matched=${match} removed=${removed}`);
            return { removed, chars: residentChars(readIndex(root).resident) } as unknown as Record<string, JsonValue>;
          }

          case 'migrate': {
            const result = await migrateAgents(ctx, root, route, {
              apply: normalized.apply === true,
              scan: cfg.enableSecretScanning,
              fileCharLimit: cfg.projectFileCharLimit,
              residentCharLimit: cfg.projectResidentCharLimit,
              indexCharLimit: cfg.projectIndexCharLimit,
              timeoutMs: cfg.projectMigrateTimeoutMs,
            });
            if (result.migrated) {
              deps.onWrite?.(root);
              logProjectWrite(ctx, exec, 'migrate', root, '', 'AGENTS.md split into resident + index');
            }
            return result as unknown as Record<string, JsonValue>;
          }

          default:
            throw new HarnessError(`未知 action "${action}"`, 'PROJECT_INVALID_ACTION');
        }
      },
    }),
  );
}

/**
 * Insert or update one index line, creating AGENTS.md when needed.
 */
async function upsertIndex(
  root: string,
  rel: string,
  summary: string,
  budget: { residentCharLimit: number; indexCharLimit: number },
): Promise<{ ok: true } | { ok: false; error: string }> {
  return mutateIndex(root, ({ resident, entries }) => {
    const exists = entries.some((e) => e.file === rel);
    const next = exists
      ? entries.map((e) => (e.file === rel ? { ...e, summary: summary || e.summary } : e))
      : [...entries, { file: rel, summary, exists: true, chars: 0 }];
    return { resident, entries: next };
  }, budget);
}
