/**
 * Project-memory archive — export one project's memory as a zip, import it on
 * another machine.
 *
 * Why this exists: project memory lives inside each repository (`AGENTS.md` +
 * `memory/**`). Committing it to git covers teammates, but the common case is
 * "I want this repository's memory on my other machine / in a fresh clone"
 * without committing anything. A zip is the smallest thing that survives a
 * copy-paste through a chat window, a USB stick, or a download folder.
 *
 * Archive layout (both names root-relative, no wrapping folder):
 *
 *   AGENTS.md            resident block + `@memory/*.md` index
 *   memory/<topic>.md    topic files
 *   manifest.json        format id, version, project name, export time
 *
 * Safety rules, all of them intentional:
 *  - entry names go through `safeMemoryRel` (no `..`, no absolute paths, no
 *    dotfiles, no non-markdown) — a zip is untrusted input;
 *  - imported text goes through the same content scanner as any other write;
 *  - nothing is destroyed: the old AGENTS.md is copied to `AGENTS.md.bak-*`
 *    and overwritten topic files move into `memory/.trash/`;
 *  - every budget is checked BEFORE the first byte is written.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  AGENTS_FILE,
  MEMORY_DIR,
  TRASH_DIR,
  listMemoryFiles,
  parseAgentsText,
  readMemoryFile,
  residentChars,
  indexChars,
  writeAgents,
  writeMemoryFile,
  safeMemoryRel,
} from './project-memory.js';
import { createZip, readZip } from './zip.js';
import { scanContent as defaultScan } from './secret-scanner.js';

/** Identifies our archives so an unrelated zip is rejected with a clear reason. */
export const ARCHIVE_FORMAT = 'dsh-persona-memory/project-archive';
export const ARCHIVE_VERSION = 1;
/** Manifest entry name (never a memory file). */
const MANIFEST_FILE = 'manifest.json';

/** Caps for reading an archive; comfortably above any real project memory. */
export const ARCHIVE_LIMITS = {
  maxEntries: 400,
  maxEntryBytes: 4 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
};

interface ArchiveManifest {
  format: string;
  version: number;
  /** project name on the exporting machine (a hint only, never trusted) */
  project?: string;
  /** absolute root on the exporting machine (informational only) */
  root?: string;
  exportedAt: string;
  files: Array<{ name: string; chars: number }>;
}

/** One exported topic file, carried through to the route response. */
export interface ArchiveFileInfo {
  name: string;
  chars: number;
}

export interface BuildArchiveResult {
  /** the zip bytes */
  buffer: Buffer;
  /** suggested download name, e.g. `demo-memory-20261108-2315.zip` */
  filename: string;
  /** files inside the archive (manifest excluded) */
  files: ArchiveFileInfo[];
  chars: number;
}

/** `demo-memory-20261108-231502.zip` — sortable, no spaces, no colons. */
export function archiveFileName(projectName: string, when: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}${p(when.getMonth() + 1)}${p(when.getDate())}-${p(when.getHours())}${p(when.getMinutes())}${p(when.getSeconds())}`;
  const safeName = (projectName || 'project').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  return `${safeName}-memory-${stamp}.zip`;
}

/**
 * Build the zip for one project.
 *
 * A project without AGENTS.md has nothing to export: the file IS the memory
 * entry point (index included), and exporting bare topic files would produce an
 * archive that cannot be imported.
 *
 * @throws Error with a user-readable reason when there is nothing to export
 */
export function buildProjectArchive(root: string, projectName: string, when: Date = new Date()): BuildArchiveResult {
  const agentsFile = path.join(root, AGENTS_FILE);
  let agentsText: string;
  try {
    agentsText = fs.readFileSync(agentsFile, 'utf8');
  } catch {
    throw new Error('该项目还没有 AGENTS.md，没有可导出的记忆');
  }

  const topics: ArchiveFileInfo[] = [];
  const entries: Array<{ name: string; data: string }> = [{ name: AGENTS_FILE, data: agentsText }];
  let chars = agentsText.length;
  for (const rel of listMemoryFiles(root)) {
    const text = readMemoryFile(root, rel);
    if (text === null) continue;
    entries.push({ name: rel, data: text });
    topics.push({ name: rel, chars: text.length });
    chars += text.length;
  }

  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    project: projectName,
    root,
    exportedAt: when.toISOString(),
    files: [{ name: AGENTS_FILE, chars: agentsText.length }, ...topics],
  };
  // The manifest goes FIRST so a human opening the zip sees what it is before
  // the (much longer) memory files.
  const buffer = createZip([
    { name: MANIFEST_FILE, data: JSON.stringify(manifest, null, 2) + '\n', mtime: when },
    ...entries.map((e) => ({ name: e.name, data: e.data, mtime: when })),
  ]);

  return {
    buffer,
    filename: archiveFileName(projectName, when),
    files: [{ name: AGENTS_FILE, chars: agentsText.length }, ...topics],
    chars,
  };
}

export interface ImportArchiveOptions {
  /** project name from the registry (shown in messages) */
  project: string;
  /** scan imported text for injected instructions / credentials */
  scan: boolean;
  residentCharLimit?: number;
  indexCharLimit?: number;
  fileCharLimit?: number;
  /** injected for tests; defaults to the real scanner */
  scanContent?: (text: string) => string | null;
  /** filesystem "now" for the backup stamp (tests pin it) */
  now?: Date;
}

export interface ImportArchiveResult {
  ok: boolean;
  /** user-facing summary line */
  message: string;
  /** files written into memory/ (root-relative) */
  written: string[];
  /** overwritten files that were moved into memory/.trash/ */
  trashed: string[];
  /** `AGENTS.md.bak-<stamp>` when the old file existed */
  backup?: string;
  /** project name recorded in the archive (may differ from this project) */
  archiveProject?: string;
  /** non-fatal notes (missing topic files, name mismatch, …) */
  warnings: string[];
  error?: string;
}

/**
 * Strip a single shared top-level folder (`zip -r demo.zip demo/` produces
 * `demo/AGENTS.md`, `demo/memory/a.md`).
 *
 * The unwrap is only applied when it actually REVEALS an `AGENTS.md` at the
 * root: without that check a legitimate archive (`memory/a.md` plus a missing
 * AGENTS.md) would be "unwrapped" into `a.md` and the real error — missing
 * AGENTS.md — would be reported as an unknown-file error instead.
 */
function normalizeEntryNames(names: readonly string[]): Map<string, string> {
  const cleaned = names.map((raw) => raw.replace(/\\/g, '/').replace(/^\.\/+/, ''));
  const out = new Map<string, string>();
  const identity = (): Map<string, string> => {
    cleaned.forEach((n, i) => out.set(names[i], n));
    return out;
  };
  if (cleaned.includes(AGENTS_FILE)) return identity();
  const stripped = cleaned.map((n) => (n.includes('/') ? n.slice(n.indexOf('/') + 1) : n));
  if (!stripped.includes(AGENTS_FILE)) return identity();
  const first = cleaned[0].split('/')[0];
  if (cleaned.some((n) => !n.includes('/') || n.split('/')[0] !== first)) return identity();
  cleaned.forEach((n, i) => out.set(names[i], stripped[i]));
  return out;
}

/**
 * Import one archive into a project.
 *
 * Every gate (zip structure, path safety, content scan, budgets) runs before
 * the first byte is written, so a rejected archive leaves the project exactly
 * as it was. A later I/O failure can still stop halfway, which is why the old
 * AGENTS.md is backed up and overwritten topics go to `.trash/` first.
 */
export async function importProjectArchive(
  root: string,
  zipBuffer: Buffer,
  opts: ImportArchiveOptions,
): Promise<ImportArchiveResult> {
  const warnings: string[] = [];
  const fail = (error: string): ImportArchiveResult => ({ ok: false, error, message: error, written: [], trashed: [], warnings });

  let raw: Array<{ name: string; data: Buffer }>;
  try {
    raw = readZip(zipBuffer, ARCHIVE_LIMITS);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  if (raw.length === 0) return fail('压缩包是空的');

  const nameMap = normalizeEntryNames(raw.map((e) => e.name));

  // ---- manifest (optional, but when present it must be ours and current)
  let manifest: ArchiveManifest | undefined;
  let agentsText: string | undefined;
  const topics = new Map<string, string>();
  const unknown: string[] = [];

  for (const entry of raw) {
    const name = nameMap.get(entry.name) ?? entry.name;
    if (name === MANIFEST_FILE) {
      try {
        const parsed = JSON.parse(entry.data.toString('utf8')) as Partial<ArchiveManifest>;
        if (parsed.format !== ARCHIVE_FORMAT) {
          return fail(`这不是本插件的项目记忆包（manifest.format=${String(parsed.format)}）`);
        }
        if (Number(parsed.version) > ARCHIVE_VERSION) {
          return fail(`记忆包版本 ${String(parsed.version)} 比当前插件支持的 ${ARCHIVE_VERSION} 新，请先升级插件`);
        }
        manifest = parsed as ArchiveManifest;
      } catch {
        return fail('manifest.json 无法解析，压缩包可能已损坏');
      }
      continue;
    }
    if (name === AGENTS_FILE) {
      agentsText = entry.data.toString('utf8');
      continue;
    }
    if (name.startsWith(`${MEMORY_DIR}/`)) {
      const rel = safeMemoryRel(root, name);
      if (!rel) {
        unknown.push(name);
        continue;
      }
      topics.set(rel, entry.data.toString('utf8'));
      continue;
    }
    unknown.push(name);
  }

  if (unknown.length > 0) {
    return fail(`压缩包内有无法识别的文件（只接受 AGENTS.md 与 memory/**.md）：${unknown.slice(0, 5).join('、')}${unknown.length > 5 ? ' 等' : ''}`);
  }
  if (agentsText === undefined) {
    return fail('压缩包缺少 AGENTS.md：没有索引文件，导入后无法还原记忆结构');
  }

  // ---- content gate (same scanner as every other write path)
  if (opts.scan) {
    const scan = opts.scanContent ?? defaultScan;
    const blocked: string[] = [];
    const hitAgents = scan(agentsText);
    if (hitAgents) blocked.push(`${AGENTS_FILE}：${hitAgents}`);
    for (const [rel, text] of topics) {
      const hit = scan(text);
      if (hit) blocked.push(`${rel}：${hit}`);
    }
    if (blocked.length > 0) {
      return fail(`内容被拒绝（疑似注入载荷或凭据）：${blocked.slice(0, 3).join('；')}。请编辑压缩包内对应文件后重试`);
    }
  }

  // ---- structure + budget gate, still before any write
  const parsed = parseAgentsText(root, agentsText);
  const residentLen = residentChars(parsed.resident);
  const indexLen = indexChars(parsed.entries);
  if (opts.residentCharLimit && residentLen > opts.residentCharLimit) {
    return fail(`常驻区超预算（${residentLen} > ${opts.residentCharLimit} 字符）：请把细节移进 memory/ 主题文件后重试`);
  }
  if (opts.indexCharLimit && indexLen > opts.indexCharLimit) {
    return fail(`索引区超预算（${indexLen} > ${opts.indexCharLimit} 字符）：请合并主题或缩短描述后重试`);
  }
  const tooBig = [...topics.entries()].filter(([, text]) => opts.fileCharLimit && text.length > opts.fileCharLimit);
  if (tooBig.length > 0) {
    const [rel, text] = tooBig[0];
    return fail(`${rel} 超单文件上限（${text.length} > ${opts.fileCharLimit} 字符）：请拆成多个主题文件后重试`);
  }

  // An index line pointing at a file that is neither in the archive nor on
  // disk is allowed (the page already renders "文件缺失"), but the user should
  // hear about it: it usually means the export was taken mid-edit.
  for (const entry of parsed.entries) {
    if (topics.has(entry.file)) continue;
    if (fs.existsSync(path.join(root, ...entry.file.split('/')))) continue;
    warnings.push(`索引里的 ${entry.file} 不在压缩包内，也没有本地文件`);
  }

  // ---- apply
  const stamp = archiveStamp(opts.now ?? new Date());
  const trashed: string[] = [];
  let backup: string | undefined;

  const agentsFile = path.join(root, AGENTS_FILE);
  try {
    if (fs.existsSync(agentsFile)) {
      backup = `${AGENTS_FILE}.bak-${stamp}`;
      fs.copyFileSync(agentsFile, path.join(root, backup));
    }
  } catch (e) {
    return fail(`备份原 AGENTS.md 失败：${e instanceof Error ? e.message : String(e)}`);
  }

  const written: string[] = [];
  for (const [rel, text] of topics) {
    const target = path.join(root, ...rel.split('/'));
    if (fs.existsSync(target)) {
      const trashDir = path.join(root, MEMORY_DIR, TRASH_DIR);
      try {
        fs.mkdirSync(trashDir, { recursive: true });
        const base = path.basename(target, '.md');
        let dest = path.join(trashDir, `${stamp}-${base}.md`);
        let n = 1;
        while (fs.existsSync(dest)) dest = path.join(trashDir, `${stamp}-${base}-${n++}.md`);
        fs.renameSync(target, dest);
        trashed.push(`${MEMORY_DIR}/${TRASH_DIR}/${path.basename(dest)}`);
      } catch (e) {
        return fail(`${rel} 无法移入 .trash：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const wrote = await writeMemoryFile(root, rel, text, opts.fileCharLimit);
    if (!wrote.ok) return fail(wrote.error);
    written.push(rel);
  }

  const agentsWrote = await writeAgents(root, parsed.resident, parsed.entries, {
    residentCharLimit: opts.residentCharLimit,
    indexCharLimit: opts.indexCharLimit,
  });
  if (!agentsWrote.ok) return fail(agentsWrote.error);

  if (manifest?.project && manifest.project !== opts.project) {
    warnings.push(`压缩包来自项目「${manifest.project}」，已导入到当前项目「${opts.project}」`);
  }

  const parts = [`导入完成：写入 ${written.length + 1} 个文件（AGENTS.md + ${written.length} 个主题文件`];
  if (backup) parts.push(`，原 AGENTS.md 备份为 ${backup}`);
  if (trashed.length) parts.push(`，${trashed.length} 个旧文件移入 ${MEMORY_DIR}/${TRASH_DIR}`);
  parts.push('）');

  return {
    ok: true,
    message: parts.join(''),
    written,
    trashed,
    backup,
    archiveProject: manifest?.project,
    warnings,
  };
}

/** `20261108-231502` — same shape the migration backup uses. */
function archiveStamp(when: Date): string {
  return when.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}
