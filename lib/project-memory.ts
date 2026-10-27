/**
 * Project memory — the per-repository memory model.
 *
 * One project = one Git repository root (every linked worktree shares it) or,
 * outside Git, the session working directory itself. Inside it we keep:
 *
 *   <root>/AGENTS.md   always-on resident rules + the index of memory files
 *   <root>/memory/     one markdown file per topic, loaded on demand
 *   <root>/memory/.trash/  deleted files (recoverable)
 *
 * AGENTS.md is loaded by the harness' own agent-instructions plugin on every
 * request, so whatever it contains is effectively resident context. The index
 * lines are the ONLY machine-readable part:
 *
 *   @memory/overview.md — migration summary, key paths
 *   @memory/run.md: how to run, schedule, retry
 *
 * Everything else in the file is resident prose and is preserved verbatim.
 * A file with no resident prose contains nothing but `@` pointer lines, which
 * is the canonical shape.
 *
 * Why pointers instead of an entry store: a repository's notes grow past any
 * single-file budget, and a model that must load all of them pays for context
 * it does not need. Pointers keep the always-injected part small and let the
 * model read exactly the topic it is working on.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findGitRepoRoot } from './projects.js';

export const AGENTS_FILE = 'AGENTS.md';
export const MEMORY_DIR = 'memory';
export const TRASH_DIR = '.trash';
export const INDEX_PREFIX = 'memory/';

/** `@memory/<path>.md` optionally followed by a `—` / `--` / `:` summary. */
const INDEX_WITH_SUMMARY = /^\s*(?:[-*+]\s+)?@(memory\/[^\s]+\.md)\s*(?:—|–|--|:)\s*(.*)$/;
/** `@memory/<path>.md` alone (no summary). */
const INDEX_BARE = /^\s*(?:[-*+]\s+)?@(memory\/[^\s]+\.md)\s*$/;

export interface IndexEntry {
  /** Root-relative path with forward slashes, e.g. `memory/overview.md`. */
  file: string;
  /** One-line description shown after the em dash; may be empty. */
  summary: string;
  /** Whether the target file currently exists on disk. */
  exists: boolean;
  /** File size in characters (0 when missing). */
  chars: number;
}

export interface ProjectIndex {
  /** Absolute project root. */
  root: string;
  /** `<root>/AGENTS.md`. */
  agentsFile: string;
  /** `<root>/memory`. */
  memoryDir: string;
  /** Whether AGENTS.md exists at all. */
  exists: boolean;
  /** Every non-index line of AGENTS.md, verbatim and in order. */
  resident: string[];
  /** Parsed `@` pointer lines. */
  entries: IndexEntry[];
  /** `memory/**` markdown files that no index line points at. */
  orphans: string[];
}

/**
 * Resolve the project root for a session working directory.
 *
 * Git repositories resolve to the repository root (so linked worktrees share
 * one memory), anything else falls back to `cwd` itself. The user's home and
 * filesystem roots are not projects — their memory is the global store.
 *
 * @param cwd absolute session working directory
 * @returns absolute project root, or null when this directory is not a project
 */
export function resolveProjectRoot(cwd: string): string | null {
  if (typeof cwd !== 'string' || cwd.trim() === '') return null;
  const resolved = path.resolve(cwd);
  const home = path.resolve(os.homedir());
  if (resolved === home || resolved === path.parse(resolved).root) return null;
  const repoRoot = findGitRepoRoot(resolved);
  return repoRoot ?? resolved;
}

/**
 * Normalize and validate a memory path supplied by a model, the admin page,
 * or the migration planner.
 *
 * This is the single gate in front of every filesystem operation: a bad path
 * here is the difference between editing `memory/notes.md` and editing
 * `/etc/passwd`. Rejects absolute paths, traversal, backslashes, non-markdown
 * files, dotfiles, and anything that resolves outside the project's memory
 * directory (including through a symlink).
 *
 * @param root absolute project root
 * @param candidate raw path, e.g. `memory/overview.md` or `overview.md`
 * @returns normalized root-relative path, or null when unsafe
 */
export function safeMemoryRel(root: string, candidate: unknown): string | null {
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!trimmed || trimmed.length > 200) return null;
  if (trimmed.includes('..') || trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) return null;
  if (!trimmed.endsWith('.md')) return null;
  // Accept a bare `overview.md` as shorthand for `memory/overview.md`, but a
  // path with a directory component must be explicit about `memory/`.
  const rel = trimmed.includes('/')
    ? (trimmed.startsWith(INDEX_PREFIX) ? trimmed : null)
    : INDEX_PREFIX + trimmed;
  if (rel === null) return null;
  const parts = rel.split('/');
  if (parts.length < 2 || parts[0] !== 'memory') return null;
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.startsWith('.'))) return null;
  if (!/^[A-Za-z0-9._\-/]+$/.test(rel)) return null;

  const memoryDir = path.resolve(root, MEMORY_DIR);
  const target = path.resolve(root, ...parts);
  if (target !== memoryDir && !target.startsWith(memoryDir + path.sep)) return null;
  if (escapesViaSymlink(root, target)) return null;
  return parts.join('/');
}

/**
 * @returns true when `target`'s existing prefix resolves outside the project
 */
function escapesViaSymlink(root: string, target: string): boolean {
  const rootReal = realpathOrSelf(path.resolve(root));
  let probe = path.dirname(target);
  while (probe.length > rootReal.length && probe.startsWith(rootReal)) {
    if (fs.existsSync(probe)) {
      const real = realpathOrSelf(probe);
      return !(real === rootReal || real.startsWith(rootReal + path.sep));
    }
    probe = path.dirname(probe);
  }
  return false;
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Parse AGENTS.md into resident prose + index entries.
 *
 * @param root absolute project root
 * @returns the parsed index (empty and `exists: false` when AGENTS.md is absent)
 */
export function readIndex(root: string): ProjectIndex {
  const agentsFile = path.join(root, AGENTS_FILE);
  const memoryDir = path.join(root, MEMORY_DIR);
  const index: ProjectIndex = {
    root,
    agentsFile,
    memoryDir,
    exists: false,
    resident: [],
    entries: [],
    orphans: [],
  };
  let raw = '';
  try {
    raw = fs.readFileSync(agentsFile, 'utf8');
    index.exists = true;
  } catch {
    index.orphans = listMemoryFiles(root);
    return index;
  }

  const resident: string[] = [];
  for (const line of raw.split('\n')) {
    const summaryMatch = INDEX_WITH_SUMMARY.exec(line);
    const bareMatch = summaryMatch ? null : INDEX_BARE.exec(line);
    const match = summaryMatch ?? bareMatch;
    if (!match) {
      resident.push(line);
      continue;
    }
    const rel = safeMemoryRel(root, match[1]);
    if (!rel) {
      // A pointer that escapes the memory directory is not an index entry;
      // keep it visible as resident text rather than silently dropping it.
      resident.push(line);
      continue;
    }
    index.entries.push({
      file: rel,
      summary: bareMatch ? '' : (match[2] ?? '').trim(),
      exists: false,
      chars: 0,
    });
  }
  index.resident = trimBlankEdges(resident);
  for (const entry of index.entries) {
    const stat = statFile(path.join(root, ...entry.file.split('/')));
    entry.exists = stat !== null;
    entry.chars = stat?.chars ?? 0;
  }
  const indexed = new Set(index.entries.map((e) => e.file));
  index.orphans = listMemoryFiles(root).filter((f) => !indexed.has(f));
  return index;
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start++;
  while (end > start && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end);
}

function statFile(file: string): { chars: number } | null {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? { chars: fs.readFileSync(file, 'utf8').length } : null;
  } catch {
    return null;
  }
}

/**
 * Render the canonical AGENTS.md text: resident prose, a blank separator, and
 * one `@memory/...` line per entry.
 */
export function renderAgents(resident: string[], entries: Array<Pick<IndexEntry, 'file' | 'summary'>>): string {
  const body = trimBlankEdges(resident);
  const lines = entries.map((e) => (e.summary ? `@${e.file} — ${e.summary}` : `@${e.file}`));
  // AGENTS.md is a normal markdown file people also edit by hand, so it ends
  // with a newline; readers trim the resulting blank line.
  if (body.length === 0 && lines.length === 0) return '';
  if (body.length === 0) return `${lines.join('\n')}\n`;
  if (lines.length === 0) return `${body.join('\n')}\n`;
  return `${body.join('\n')}\n\n${lines.join('\n')}\n`;
}

/** Resident text length (what actually costs always-on context). */
export function residentChars(resident: string[]): number {
  return trimBlankEdges(resident).join('\n').length;
}

/** Index text length. */
export function indexChars(entries: Array<Pick<IndexEntry, 'file' | 'summary'>>): number {
  return renderAgents([], entries).length;
}

// --------------------------------------------------------------- write locks

/** per-file write chains, so read-modify-write cycles never interleave */
const queues = new Map<string, Promise<unknown>>();

function withLock<T>(file: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = queues.get(file) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  queues.set(file, next);
  return next.finally(() => {
    if (queues.get(file) === next) queues.delete(file);
  });
}

async function writeAtomic(file: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await fs.promises.writeFile(tmp, content, 'utf8');
  await fs.promises.rename(tmp, file);
}

export interface AgentsBudget {
  /** max characters of resident prose (0/undefined = unbounded) */
  residentCharLimit?: number;
  /** max characters of the whole index block (0/undefined = unbounded) */
  indexCharLimit?: number;
}

/**
 * Rewrite AGENTS.md from resident prose + entries.
 *
 * Budget failures are returned, never silently trimmed: dropping a resident
 * rule is exactly the failure mode this file exists to prevent.
 *
 * @returns `{ ok: true }` after a successful atomic write, or `{ ok: false, error }`
 */
export async function writeAgents(
  root: string,
  resident: string[],
  entries: Array<Pick<IndexEntry, 'file' | 'summary'>>,
  budget: AgentsBudget = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const body = trimBlankEdges(resident);
  const residentLen = body.join('\n').length;
  if (budget.residentCharLimit && residentLen > budget.residentCharLimit) {
    return { ok: false, error: `常驻区超预算（${residentLen} > ${budget.residentCharLimit} 字符）：请把细节移进 memory/ 文件，只保留操作性硬约束` };
  }
  const indexLen = indexChars(entries);
  if (budget.indexCharLimit && indexLen > budget.indexCharLimit) {
    return { ok: false, error: `索引区超预算（${indexLen} > ${budget.indexCharLimit} 字符）：请合并主题或缩短描述` };
  }
  await withLock(path.join(root, AGENTS_FILE), async () => {
    await writeAtomic(path.join(root, AGENTS_FILE), renderAgents(body, entries));
  });
  return { ok: true };
}

/**
 * Mutate the index atomically: re-read AGENTS.md inside the lock, hand the
 * parsed state to `mutate`, then write it back when `mutate` returns state.
 */
export async function mutateIndex(
  root: string,
  mutate: (current: { resident: string[]; entries: IndexEntry[] }) =>
    | { resident?: string[]; entries?: IndexEntry[]; error?: string }
    | undefined,
  budget: AgentsBudget = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  return withLock(path.join(root, AGENTS_FILE), async () => {
    const current = readIndex(root);
    const outcome = mutate({ resident: current.resident, entries: current.entries });
    if (!outcome) return { ok: true } as const;
    if (outcome.error) return { ok: false, error: outcome.error } as const;
    const resident = outcome.resident ?? current.resident;
    const entries = outcome.entries ?? current.entries;
    const residentLen = trimBlankEdges(resident).join('\n').length;
    if (budget.residentCharLimit && residentLen > budget.residentCharLimit) {
      return { ok: false, error: `常驻区超预算（${residentLen} > ${budget.residentCharLimit} 字符）` } as const;
    }
    const indexLen = indexChars(entries);
    if (budget.indexCharLimit && indexLen > budget.indexCharLimit) {
      return { ok: false, error: `索引区超预算（${indexLen} > ${budget.indexCharLimit} 字符）` } as const;
    }
    await writeAtomic(path.join(root, AGENTS_FILE), renderAgents(resident, entries));
    return { ok: true } as const;
  });
}

// ------------------------------------------------------------- memory files

/**
 * @returns the file's text, or null when it does not exist
 */
export function readMemoryFile(root: string, rel: string): string | null {
  const safe = safeMemoryRel(root, rel);
  if (!safe) return null;
  try {
    return fs.readFileSync(path.join(root, ...safe.split('/')), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Write (or create) one memory file.
 *
 * @param content full file content
 * @param maxChars per-file budget (0/undefined = unbounded)
 */
export async function writeMemoryFile(
  root: string,
  rel: string,
  content: string,
  maxChars?: number,
): Promise<{ ok: true; file: string; chars: number } | { ok: false; error: string }> {
  const safe = safeMemoryRel(root, rel);
  if (!safe) return { ok: false, error: `非法记忆文件名：${String(rel)}` };
  const text = content.replace(/\r\n/g, '\n');
  if (maxChars && text.length > maxChars) {
    return { ok: false, error: `单个记忆文件超上限（${text.length} > ${maxChars} 字符）：请拆成多个主题文件` };
  }
  const file = path.join(root, ...safe.split('/'));
  await withLock(file, async () => {
    await writeAtomic(file, text);
  });
  return { ok: true, file: safe, chars: text.length };
}

/**
 * Append to one memory file, inserting a blank line first when needed.
 */
export async function appendMemoryFile(
  root: string,
  rel: string,
  content: string,
  maxChars?: number,
): Promise<{ ok: true; file: string; chars: number } | { ok: false; error: string }> {
  const safe = safeMemoryRel(root, rel);
  if (!safe) return { ok: false, error: `非法记忆文件名：${String(rel)}` };
  const file = path.join(root, ...safe.split('/'));
  return withLock(file, async () => {
    let existing = '';
    try {
      existing = fs.readFileSync(file, 'utf8');
    } catch {
      existing = '';
    }
    const chunk = content.replace(/\r\n/g, '\n').trim();
    if (!chunk) return { ok: false as const, error: '追加内容不能为空' };
    const next = existing.trim() === '' ? `${chunk}\n` : `${existing.replace(/\s+$/, '')}\n\n${chunk}\n`;
    if (maxChars && next.length > maxChars) {
      return { ok: false as const, error: `单个记忆文件超上限（${next.length} > ${maxChars} 字符）：请拆成多个主题文件或先精简` };
    }
    await writeAtomic(file, next);
    return { ok: true as const, file: safe, chars: next.length };
  });
}

/**
 * Delete one memory file by moving it into `memory/.trash/` (recoverable).
 *
 * @returns the trash path, or an error when the file does not exist
 */
export async function deleteMemoryFile(
  root: string,
  rel: string,
): Promise<{ ok: true; trashed: string } | { ok: false; error: string }> {
  const safe = safeMemoryRel(root, rel);
  if (!safe) return { ok: false, error: `非法记忆文件名：${String(rel)}` };
  const file = path.join(root, ...safe.split('/'));
  return withLock(file, async () => {
    if (!fs.existsSync(file)) return { ok: false as const, error: `${safe} 不存在` };
    const trashDir = path.join(root, MEMORY_DIR, TRASH_DIR);
    await fs.promises.mkdir(trashDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const base = path.basename(file, '.md');
    let target = path.join(trashDir, `${stamp}-${base}.md`);
    let n = 1;
    while (fs.existsSync(target)) target = path.join(trashDir, `${stamp}-${base}-${n++}.md`);
    await fs.promises.rename(file, target);
    return { ok: true as const, trashed: `${MEMORY_DIR}/${TRASH_DIR}/${path.basename(target)}` };
  });
}

/** Every markdown file under `memory/`, excluding `.trash`, sorted. */
export function listMemoryFiles(root: string): string[] {
  const memoryDir = path.join(root, MEMORY_DIR);
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(`${MEMORY_DIR}/${rel}`);
      }
    }
  };
  walk(memoryDir, '');
  out.sort();
  return out;
}

export interface MemorySearchHit {
  file: string;
  line: number;
  text: string;
  chars: number;
}

/**
 * Substring AND search across every project memory file.
 *
 * Every whitespace-separated term must appear (case-insensitively) somewhere
 * in the file — the same semantics as the global store's fallback search, so
 * `Alex gardener macOS` finds a file whose lines contain those words in any
 * order. Matching lines are returned for context.
 */
export function searchMemoryFiles(root: string, query: string, maxResults: number): MemorySearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const hits: MemorySearchHit[] = [];
  for (const rel of listMemoryFiles(root)) {
    const text = readMemoryFile(root, rel);
    if (text === null) continue;
    const lower = text.toLowerCase();
    if (!terms.every((t) => lower.includes(t))) continue;
    const lines = text.split('\n');
    const matching = lines.filter((line) => terms.every((t) => line.toLowerCase().includes(t)));
    const picked = (matching.length > 0 ? matching : lines.filter((line) => terms.some((t) => line.toLowerCase().includes(t)))).slice(0, 2);
    for (const line of picked) {
      hits.push({
        file: rel,
        line: lines.indexOf(line) + 1,
        text: line.trim().slice(0, 400),
        chars: text.length,
      });
      if (hits.length >= maxResults) return hits;
    }
    if (hits.length >= maxResults) return hits;
  }
  return hits;
}
