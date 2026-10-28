/**
 * Admin routes + auto-protect for dsh-persona-memory — the browser-half
 * settings page ("记忆管理") talks to these /api/persona-memory/* routes.
 *
 * Why routes instead of harness.handle: this is the shipped bundle plugin,
 * so the client half is a prebuilt `window.__ModuleLoader__` bundle served
 * at /plugins/<id>/client.js; it cannot use dynamic-plugin RPC. Following
 * the dsh-ssh precedent, the client uses plain same-origin fetch against
 * routes registered on the host `webServer` service.
 *
 * Every route is loopback-only (same fence dsh-ssh uses): these endpoints
 * read and mutate the shared memory files, so a LAN-exposed web deployment
 * must not serve them. The one deliberate exception is the instance's own
 * advertised public authority (a reverse tunnel), resolved per request from
 * the same URL file `dsh-web-run.sh` uses, because a Cloudflare Quick Tunnel
 * gets a new random hostname on every restart. The loopback peer requirement
 * is never relaxed.
 *
 * Auto-protect (startAutoProtect): a background tick every minute that
 *   1. backs up all memory files into $DSH_HOME/memory-backup/latest/
 *      (single overwritten snapshot; interval = autoBackupMin minutes)
 *   2. watches the Pi shared dir: if MEMORY.md was seen and then vanishes,
 *      switches the profile `dir` config to $DSH_HOME/memory and restores
 *      from the latest backup.
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseEntries, decodeEntry, ENTRY_DELIMITER, isEnoent, type DecodedEntry, type MemoryKind, type MemoryStore } from './memory-store.js';
import { parseInstructions, normalizeInstruction, type StandingStore } from './standing.js';
import {
  resolveProjectRoot,
  readIndex,
  readMemoryFile,
  writeMemoryFile,
  deleteMemoryFile,
  mutateIndex,
  safeMemoryRel,
  residentChars,
  indexChars,
  type ProjectIndex,
} from './project-memory.js';
import { listRegistered, rootForName, registerProject, scanAndRegister, type RegisteredProject } from './project-registry.js';
import { migrateAgents } from './project-migrate.js';
import { projectGuideText } from './project-guide.js';
import { scanContent } from './secret-scanner.js';
import type { LlmRoute } from './llm-helper.js';
import type { VectorIndex } from './vector-index.js';
import type { Context } from '@deepseek-ai/cordis';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';

/** Cap on JSON request bodies (admin payloads are small). */
const MAX_JSON_BODY_BYTES = 64 * 1024;

/** Read a config value as a non-empty string, else the fallback. */
function cfgStr(cfg: Record<string, unknown>, key: string, fallback: string): string {
  const v = cfg[key];
  return typeof v === 'string' && v.trim() !== '' ? v : fallback;
}

/** Read a config value as a boolean (accepting the string form), else the fallback. */
function cfgBool(cfg: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = cfg[key];
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return fallback;
}

/** Read a config value as a finite number, else the fallback. */
function cfgNum(cfg: Record<string, unknown>, key: string, fallback: number): number {
  const v = cfg[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Backup root under the DSH home (never inside the Pi-shared dir). */
export const BACKUP_BASE = path.join(os.homedir(), '.dsh', 'memory-backup');
/** The live snapshot every write refreshes. */
export const BACKUP_LATEST = path.join(BACKUP_BASE, 'latest');
/** Dated snapshots, so an accidental delete is recoverable (see `pruneSnapshots`). */
export const BACKUP_HISTORY = path.join(BACKUP_BASE, 'history');
/** How many dated snapshots to keep. */
export const BACKUP_KEEP = 14;

/** Where one backup run writes: the live mirror plus an optional dated copy. */
export interface BackupPaths {
  latest: string;
  history?: string;
}

/**
 * Resolve the backup destination.
 *
 * `cfg.backupDir` exists so tests never touch the real `~/.dsh/memory-backup`
 * (a smoke run used to deposit a hundred throwaway project snapshots there).
 * `history: false` skips the dated copy (used by the periodic auto-backup).
 */
export function backupPaths(cfg: Record<string, unknown>, opts: { history?: boolean } = {}): BackupPaths {
  const base = typeof cfg.backupDir === 'string' && cfg.backupDir.trim()
    ? cfg.backupDir.trim()
    : BACKUP_BASE;
  const paths: BackupPaths = { latest: path.join(base, 'latest') };
  if (opts.history !== false) {
    const historyRoot = path.join(base, 'history');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    // Two backups inside the same second must not overwrite each other, or the
    // "history" promise silently degrades to the old overwrite behaviour.
    let candidate = path.join(historyRoot, stamp);
    let n = 1;
    while (fs.existsSync(candidate)) candidate = path.join(historyRoot, `${stamp}-${n++}`);
    paths.history = candidate;
  }
  return paths;
}

/** Keep only the newest `keep` dated snapshots. */
export function pruneSnapshots(historyDir: string, keep = BACKUP_KEEP): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(historyDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();  // ISO-ish stamps sort chronologically
  let removed = 0;
  for (const name of dirs.slice(0, Math.max(0, dirs.length - keep))) {
    fs.rmSync(path.join(historyDir, name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

/**
 * Default file holding the currently advertised public URL of this DSH
 * instance — the same file `dsh-web-run.sh` reads for `--trusted-host`.
 * A Quick Tunnel rewrites it on every restart, which is exactly why the
 * admin fence must re-read it rather than trust a pinned hostname.
 */
export const DEFAULT_ALLOWED_HOSTS_FILE = '/var/lib/cloudflared/dsh-url.txt';

/** The four memory file basenames + project file prefix. */
const MEMORY_FILES = ['MEMORY.md', 'USER.md', 'failures.md', 'STANDING.md'];
const PROJECT_PREFIX = 'projects-';

/**
 * Loopback-guarded admin surface.
 *
 * Three layers are enforced:
 *   1. the TCP peer must be a loopback address (a reverse tunnel such as
 *      cloudflared connects FROM 127.0.0.1, so a tunnel still passes this);
 *   2. the `Host` header must be a loopback literal by default;
 *   3. the browser's same-origin markers must agree.
 *
 * Layer 2 is what blocks a browser that reaches the UI through a tunnel /
 * reverse proxy: the `Host` header carries the public authority, not
 * `127.0.0.1`, so every admin call returns `forbidden: loopback-only`.
 * `adminAllowedHosts` therefore lets the operator declare extra authorities
 * (e.g. the Cloudflare Quick Tunnel hostname). This is opt-in, never a
 * blanket "allow any Host": LAYER 1 STILL APPLIES, so the request must still
 * originate from this machine's loopback interface. It does not widen who can
 * connect, only which authority the already-local connection may claim.
 */
/**
 * Loopback-guarded admin surface.
 *
 * Three layers are enforced:
 *   1. the TCP peer must be a loopback address (a reverse tunnel such as
 *      cloudflared connects FROM 127.0.0.1, so a tunnel still passes this);
 *   2. the `Host` header must be a loopback literal, or the authority of the
 *      currently advertised public URL;
 *   3. the browser's same-origin markers must agree.
 *
 * Layer 2 is what blocks a browser that reaches the UI through a tunnel /
 * reverse proxy: the `Host` header carries the public authority, not
 * `127.0.0.1`, so every admin call returned `forbidden: loopback-only`.
 *
 * Why the current tunnel authority is READ AT REQUEST TIME instead of being
 * configured: Cloudflare Quick Tunnels get a NEW random hostname on every
 * restart, so a pinned value would go stale on the next `systemctl restart
 * cloudflared-dsh`. The same source `dsh-web-run.sh` already uses for
 * `--trusted-host` is consulted (`adminAllowedHostsFile`, default
 * `/var/lib/cloudflared/dsh-url.txt`), so both sides always agree on the
 * current generation. LAYER 1 STILL APPLIES: this widens which authority an
 * already-local connection may claim, never who may connect.
 */
function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
}

/** Extract the lowercase `host[:port]` authority out of one URL string. */
function authorityOf(urlText: string): string {
  const trimmed = urlText.trim();
  if (!trimmed) return '';
  try {
    return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Resolve the authorities the admin API may accept beyond loopback literals.
 *
 * Sources, in order (all optional, all pinned to this machine's own files):
 *   - `adminAllowedHosts`: static extras from the config (array or
 *     comma/space separated string);
 *   - `adminAllowedHostsFile`: a file holding the currently advertised public
 *     URL (default: the Quick Tunnel URL file shared with `dsh-web-run.sh`).
 *
 * The file is re-read per request so a tunnel restart is picked up without a
 * plugin reload; the read is cheap and failure-tolerant (a missing or
 * unreadable file simply contributes nothing).
 */
export function resolveAllowedHosts(cfg: Record<string, unknown>): string[] {
  const out = new Set<string>();

  const raw = cfg.adminAllowedHosts;
  const staticList = Array.isArray(raw)
    ? raw.filter((h): h is string => typeof h === 'string')
    : typeof raw === 'string'
      ? raw.split(/[,\s]+/)
      : [];
  for (const entry of staticList) {
    const auth = authorityOf(entry);
    if (auth) out.add(auth);
  }

  const fileCfg = typeof cfg.adminAllowedHostsFile === 'string' ? cfg.adminAllowedHostsFile.trim() : '';
  const filePath = fileCfg || DEFAULT_ALLOWED_HOSTS_FILE;
  try {
    const auth = authorityOf(fs.readFileSync(filePath, 'utf8'));
    if (auth) out.add(auth);
  } catch {
    // absent/unreadable: no extra authority is granted
  }

  return [...out];
}

export function isLoopbackRequest(request: IncomingMessage, allowedHosts: readonly string[] = []): boolean {
  const address = request.socket.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
  const host = request.headers.host;
  if (typeof host !== 'string') return false;
  let hostUrl: URL;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  // Layer 2: loopback literal, or the current public authority.
  const hostAllowed = isLoopbackHostname(hostUrl.hostname) || allowedHosts.includes(hostUrl.host.toLowerCase());
  if (!hostAllowed) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/** One JSON response. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' });
  res.end(payload);
}

/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_JSON_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** URL query helper (first value, decoded). */
function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null ? undefined : value;
}

/** today as YYYY-MM-DD (hermes date format). */
function today(): string {
  return new Date().toISOString().split('T')[0];
}

/** Encode one entry line (hermes MemoryStore.encodeEntry). */
function encodeEntry(text: string, created: string, lastReferenced: string, project?: string | null): string {
  const projectMetadata = project?.trim()
    ? `, project64=${Buffer.from(project.trim(), 'utf-8').toString('base64url')}`
    : '';
  return `${text} <!-- created=${created}, last=${lastReferenced}${projectMetadata} -->`;
}

/** Read raw file text or null when absent. */
function readRaw(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/** Write raw file text atomically (temp + rename). */
function writeRawAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Resolve the active memory dir (mirrors index.ts resolveDir):
 * explicit config dir → Pi has MEMORY.md → $DSH_HOME/memory.
 */
export function resolveMemoryDir(cfg: Record<string, unknown>): string {
  if (cfg.dir && String(cfg.dir).trim()) return String(cfg.dir).trim();
  const piMem = path.join(os.homedir(), '.pi', 'agent', 'pi-hermes-memory', 'MEMORY.md');
  if (fs.existsSync(piMem)) return path.join(os.homedir(), '.pi', 'agent', 'pi-hermes-memory');
  return path.join(os.homedir(), '.dsh', 'memory');
}

// ------------------------------------------------------------- schema

export interface SchemaField {
  key: string;
  type: 'string' | 'number' | 'bool' | 'select';
  label: string;
  group: string;
  help?: string;
  options?: string[];
}

/** Config schema surfaced to the admin page (mirrors index.ts cfg defaults). */
export const CFG_SCHEMA: SchemaField[] = [
  { key: 'dir', type: 'string', label: '记忆目录', group: '基础', help: '显式设置优先；默认：Pi 有 MEMORY.md 才共享，否则用 $DSH_HOME/memory' },
  { key: 'memoryCharLimit', type: 'number', label: 'MEMORY 字符上限', group: '基础' },
  { key: 'userCharLimit', type: 'number', label: 'USER 字符上限', group: '基础' },
  { key: 'enableSecretScanning', type: 'bool', label: '写入内容扫描', group: '基础', help: '拦截提示注入/凭据' },
  { key: 'inject', type: 'bool', label: '注入记忆段落', group: '基础', help: '每请求注入 system prompt' },
  { key: 'injectHumanOnly', type: 'bool', label: '仅人类会话注入', group: '基础', help: '子代理/派生会话不注入记忆（继承父会话上下文）' },
  { key: 'sectionOrder', type: 'number', label: '记忆段顺序', group: '基础' },
  { key: 'searchMaxResults', type: 'number', label: '搜索最大条数', group: '检索' },
  { key: 'usageNudgeThreshold', type: 'number', label: '用量提醒阈值', group: '基础', help: '0~1，达此比例提醒合并' },
  { key: 'correctionDetection', type: 'bool', label: '纠正检测', group: '学习', help: 'feedback/record 自动存纠正条目' },
  { key: 'correctionPatternDetection', type: 'bool', label: '对话内纠正检测', group: '学习' },
  { key: 'correctionHumanOnly', type: 'bool', label: '仅人类会话纠正', group: '学习', help: '子代理/派生会话不产生纠正条目' },
  { key: 'correctionRateLimitTurns', type: 'number', label: '纠正限频（轮）', group: '学习' },
  { key: 'learnEnabled', type: 'bool', label: '后台学习', group: '学习', help: '每 N 轮复习对话提取事实' },
  { key: 'learnHumanOnly', type: 'bool', label: '仅人类会话学习', group: '学习', help: '子代理/派生会话不提取事实写入记忆' },
  { key: 'learnIntervalTurns', type: 'number', label: '学习间隔（轮）', group: '学习' },
  { key: 'learnRecentTurns', type: 'number', label: '学习近 N 轮', group: '学习' },
  { key: 'learnMaxChars', type: 'number', label: '学习最大字符', group: '学习' },
  { key: 'learnTimeoutMs', type: 'number', label: '学习超时（ms）', group: '学习' },
  { key: 'autoConsolidate', type: 'bool', label: '自动合并', group: '合并', help: '超限用 LLM 合并精简' },
  { key: 'consolidateStaleDays', type: 'number', label: '合并陈旧天数', group: '合并' },
  { key: 'consolidateTimeoutMs', type: 'number', label: '合并超时（ms）', group: '合并' },
  { key: 'standingEnabled', type: 'bool', label: '常驻指令注入', group: '常驻' },
  { key: 'standingCharLimit', type: 'number', label: '常驻字符预算', group: '常驻' },
  { key: 'standingMaxEntries', type: 'number', label: '常驻最大条数', group: '常驻' },
  { key: 'failureInjectionEnabled', type: 'bool', label: '失败记忆注入', group: '失败' },
  { key: 'failureMaxAgeDays', type: 'number', label: '失败记忆天数', group: '失败' },
  { key: 'failureMaxEntries', type: 'number', label: '失败记忆条数', group: '失败' },
  { key: 'failureCharLimit', type: 'number', label: '失败字符上限', group: '失败' },
  { key: 'projectEnabled', type: 'bool', label: '项目记忆', group: '项目', help: '按会话 cwd 定位 git 仓库根，读写其 AGENTS.md + memory/' },
  { key: 'projectFileCharLimit', type: 'number', label: '单文件字符上限', group: '项目', help: '每个 memory/<主题>.md 的上限' },
  { key: 'projectResidentCharLimit', type: 'number', label: '常驻区预算', group: '项目', help: 'AGENTS.md 常驻区字符上限' },
  { key: 'projectIndexCharLimit', type: 'number', label: '索引区预算', group: '项目', help: '@memory/ 指针行总字符上限' },
  { key: 'projectAutoMigrate', type: 'bool', label: '自动迁移旧 AGENTS.md', group: '项目', help: '首次写入时用辅助 LLM 把 prose AGENTS.md 拆成常驻+索引' },
  { key: 'projectBootstrapHint', type: 'bool', label: '新建项目记忆引导', group: '项目', help: '无记忆的 git 仓库里注入「怎么写项目记忆」的简短引导（否则新项目永远不知道该建）' },
  { key: 'memoryFtsEnabled', type: 'bool', label: 'FTS5 全文索引', group: '检索' },
  { key: 'vectorEnabled', type: 'bool', label: '向量搜索', group: '向量', help: 'FTS5+向量 RRF 混合检索' },
  { key: 'vectorIndexDir', type: 'string', label: '向量索引目录', group: '向量', help: '默认 $DSH_HOME/memory' },
  { key: 'embeddingProvider', type: 'select', options: ['remote', 'local'], label: 'embedding 提供方', group: '向量', help: 'local=transformers.js 本地模型' },
  { key: 'embeddingBaseUrl', type: 'string', label: '远程 API 基址', group: '向量', help: 'OpenAI 兼容 /embeddings' },
  { key: 'embeddingApiKey', type: 'string', label: '远程 API Key', group: '向量', help: '或 DSH_EMBEDDING_API_KEY' },
  { key: 'embeddingModel', type: 'string', label: 'embedding 模型', group: '向量' },
  { key: 'embeddingCacheDir', type: 'string', label: '模型缓存目录', group: '向量', help: '默认 $DSH_HOME/models' },
  { key: 'embeddingRemoteHost', type: 'string', label: '下载源镜像', group: '向量', help: '大陆可用 https://hf-mirror.com' },
  { key: 'adminProfile', type: 'string', label: '配置写回 profile', group: '管理', help: '默认 web' },
  { key: 'adminAllowedHosts', type: 'string', label: '管理接口允许的额外主机', group: '管理', help: '隧道/反代时填公网域名，多个用逗号分隔；仍要求连接来自本机回环' },
  { key: 'autoBackupMin', type: 'number', label: '自动备份间隔（分钟）', group: '备份', help: '0=关闭；默认 60；只保留最新一份' },
  { key: 'autoSwitchOnPiLoss', type: 'bool', label: 'Pi 丢失自动切换', group: '备份', help: 'Pi 记忆消失时自动切到本地并恢复' },
];

/** Config defaults (mirrors index.ts). */
export const CFG_DEFAULTS: Record<string, unknown> = {
  memoryCharLimit: 5000, userCharLimit: 5000, enableSecretScanning: true, inject: true, injectHumanOnly: true,
  sectionOrder: 55, searchMaxResults: 10, usageNudgeThreshold: 0.9, correctionDetection: true,
  correctionPatternDetection: true, correctionHumanOnly: true,
  correctionRateLimitTurns: 3, learnEnabled: true, learnHumanOnly: true, learnIntervalTurns: 10,
  learnRecentTurns: 2, learnMaxChars: 6000,
  learnTimeoutMs: 120000, autoConsolidate: true, consolidateStaleDays: 30, consolidateTimeoutMs: 120000,
  standingEnabled: true, standingCharLimit: 2000, standingMaxEntries: 20, failureInjectionEnabled: true,
  failureMaxAgeDays: 7, failureMaxEntries: 5, failureCharLimit: 10000,
  projectEnabled: true, projectFileCharLimit: 20000, projectResidentCharLimit: 3000,
  projectIndexCharLimit: 4000, projectAutoMigrate: true, projectBootstrapHint: true,
  memoryFtsEnabled: true, vectorEnabled: false, embeddingProvider: 'remote', embeddingModel: 'text-embedding-3-small',
  embeddingRemoteHost: 'https://huggingface.co', adminProfile: 'web', adminAllowedHosts: '',
  autoBackupMin: 60, autoSwitchOnPiLoss: true,
};

// ------------------------------------------------- profile patch (config)

/** Parse the persona-memory section config out of a patch YAML text. */
export function parseSectionConfig(content: string, id: string): Record<string, unknown> {
  const lines = content.split(/\r?\n/);
  let inSection = false;
  let inConfig = false;
  let lastKey = '';
  const cfg: Record<string, unknown> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inSection) {
      if (/^-\s*id:\s*/.test(trimmed) && trimmed.includes(id)) { inSection = true; continue; }
      continue;
    }
    if (inConfig) {
      const item = /^\s+-\s*(.*)$/.exec(line);
      if (item && line.startsWith('      ') && lastKey) {
        const cur = Array.isArray(cfg[lastKey]) ? (cfg[lastKey] as unknown[]) : [];
        cur.push(item[1].trim().replace(/^['"]|['"]$/g, ''));
        cfg[lastKey] = cur;
        continue;
      }
      const m = /^\s*([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
      if (m && line.startsWith('    ')) {
        const v = m[2].trim();
        lastKey = m[1];
        const bare = v.replace(/^['"]|['"]$/g, '');
        cfg[m[1]] = v === '[]' ? []
          : !/^['"]/.test(v) && v === 'true' ? true
            : !/^['"]/.test(v) && v === 'false' ? false
              : !/^['"]/.test(v) && v !== '' && Number.isFinite(Number(v)) ? Number(v)
                : bare;
        continue;
      }
      if (!line.startsWith('    ') && line.trim()) break;
      continue;
    }
    if (/^\s*config:\s*$/.test(line) && line.startsWith('  ')) { inConfig = true; continue; }
    if (!line.startsWith(' ') && line.trim()) break;
  }
  return cfg;
}

/** Update (or append) the persona-memory section config in a patch YAML. */
export function updateSectionConfig(content: string, id: string, cfg: Record<string, unknown>): string {
  const lines = content.split(/\r?\n/);
  let sectionIdx = -1;
  let configIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (sectionIdx < 0 && /^-\s*id:\s*/.test(t) && t.includes(id)) { sectionIdx = i; continue; }
    if (sectionIdx >= 0 && /^\s*config:\s*$/.test(lines[i]) && lines[i].startsWith('  ')) { configIdx = i; break; }
    if (sectionIdx >= 0 && i > sectionIdx && lines[i].trim() && !lines[i].startsWith(' ') && !/^-\s*id:/.test(t)) break;
  }
  const scalar = (v: unknown): string => typeof v === 'boolean' ? (v ? 'true' : 'false')
    : typeof v === 'number' ? String(v)
      : `'${String(v).replace(/'/g, "''")}'`;
  /** Render one key; arrays become block sequences so YAML keeps them arrays. */
  const renderKey = (k: string): string[] => {
    const v = cfg[k];
    if (Array.isArray(v)) {
      if (!v.length) return ['    ' + k + ': []'];
      return ['    ' + k + ':', ...v.map((item) => '      - ' + scalar(item))];
    }
    return ['    ' + k + ': ' + scalar(v)];
  };
  if (sectionIdx < 0) {
    const block = ['', `- id: ${id}`, '  config:', ...Object.keys(cfg).flatMap(renderKey)];
    return content.replace(/\s*$/, '') + '\n' + block.join('\n') + '\n';
  }
  if (configIdx < 0) {
    const block = ['  config:', ...Object.keys(cfg).flatMap(renderKey)];
    lines.splice(sectionIdx + 1, 0, ...block);
    return lines.join('\n');
  }
  const endIdx = (() => {
    for (let i = configIdx + 1; i < lines.length; i++) {
      if (lines[i].trim() && !lines[i].startsWith('    ') && !lines[i].startsWith('  ')) return i;
      if (lines[i].trim() && lines[i].startsWith('  ') && !lines[i].startsWith('    ')) return i;
    }
    return lines.length;
  })();
  // Rebuild the config block: existing keys keep their order, changed values
  // are re-rendered (an array may span lines), unknown keys are appended.
  const seen = new Set<string>();
  const body: string[] = [];
  for (let i = configIdx + 1; i < endIdx; i++) {
    const m = /^\s*([A-Za-z][A-Za-z0-9_]*):/.exec(lines[i]);
    if (!m) {
      // sequence item ("      - ...") or noise: keep only if its parent was kept
      if (/^\s*-\s/.test(lines[i])) continue;
      body.push(lines[i]);
      continue;
    }
    const k = m[1];
    if (seen.has(k)) continue;
    seen.add(k);
    if (k in cfg) body.push(...renderKey(k));
    else {
      body.push(lines[i]);
      // keep a following block sequence that belongs to this key
      let j = i + 1;
      while (j < endIdx && /^\s+-\s/.test(lines[j])) body.push(lines[j++]);
      i = j - 1;
    }
  }
  for (const k of Object.keys(cfg)) if (!seen.has(k)) body.push(...renderKey(k));
  lines.splice(configIdx + 1, endIdx - configIdx - 1, ...body);
  return lines.join('\n');
}

// ------------------------------------------------------------- backup

/** List current backup snapshots (single latest dir). */
export function listBackups(): Array<{ name: string; files: number }> {
  try {
    const names = fs.readdirSync(BACKUP_LATEST, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
    return [{ name: 'latest', files: names.length }];
  } catch {
    return [];
  }
}

/** @returns whether the copy happened */
async function copyIfExists(src: string, dst: string): Promise<boolean> {
  try {
    const s = fs.statSync(src);
    if (!s.isFile()) return false;
    writeRawAtomic(dst, fs.readFileSync(src, 'utf8'));
    return true;
  } catch {
    return false;
  }
}

/** Backup subdirectory holding per-project snapshots. */
const PROJECT_BACKUP_DIR = 'projects';

/** Recursively copy a directory, skipping dot-entries unless allowed. */
async function copyTree(src: string, dst: string, skipDots = true): Promise<number> {
  let count = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (skipDots && entry.name.startsWith('.')) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      count += await copyTree(from, to, skipDots);
    } else if (entry.isFile()) {
      if (await copyIfExists(from, to)) count++;
    }
  }
  return count;
}

/**
 * Backup all memory into latest/ (overwrite).
 *
 * Global stores are flat files; project memory now lives inside each
 * repository, so it is snapshotted as `latest/projects/<name>/{AGENTS.md,memory/**}`
 * driven by the registry (`.trash` and dot-entries are skipped — trash is
 * intentionally excluded from backups).
 */
export async function backupAll(
  cfg: Record<string, unknown>,
  opts: { history?: boolean } = {},
): Promise<{ ok: boolean; message: string }> {
  const dir = resolveMemoryDir(cfg);
  const paths = backupPaths(cfg, opts);
  let count = 0;
  const writeSnapshot = async (root: string): Promise<void> => {
    for (const name of MEMORY_FILES) {
      if (await copyIfExists(path.join(dir, name), path.join(root, name))) count++;
    }
    for (const project of listRegistered(dir)) {
      if (!project.exists) continue;
      const target = path.join(root, PROJECT_BACKUP_DIR, project.name);
      if (await copyIfExists(path.join(project.root, 'AGENTS.md'), path.join(target, 'AGENTS.md'))) count++;
      count += await copyTree(path.join(project.root, 'memory'), path.join(target, 'memory'));
    }
  };
  await writeSnapshot(paths.latest);
  if (paths.history) {
    await writeSnapshot(paths.history);
    pruneSnapshots(path.dirname(paths.history));
  }
  const note = paths.history ? `，历史快照 ${path.basename(paths.history)}` : '';
  return { ok: true, message: `备份完成（${count} 个文件）→ ${paths.latest}${note}` };
}

/**
 * Restore from latest backup.
 * @param targetDir override destination (defaults to resolveMemoryDir(cfg))
 * @returns number of restored files
 */
export async function restoreFromLatest(
  cfg: Record<string, unknown>,
  targetDir?: string,
  snapshot?: string,
): Promise<number> {
  const dir = targetDir || resolveMemoryDir(cfg);
  const from = snapshot ?? backupPaths(cfg, { history: false }).latest;
  let count = 0;
  for (const f of MEMORY_FILES) {
    if (await copyIfExists(path.join(from, f), path.join(dir, f))) count++;
  }
  for (const project of listRegistered(dir)) {
    const source = path.join(from, PROJECT_BACKUP_DIR, project.name);
    if (!fs.existsSync(source)) continue;
    if (await copyIfExists(path.join(source, 'AGENTS.md'), path.join(project.root, 'AGENTS.md'))) count++;
    count += await copyTree(path.join(source, 'memory'), path.join(project.root, 'memory'));
  }
  return count;
}

// ------------------------------------------------------------- build

export interface AdminRouteDeps {
  store: MemoryStore;
  standing: StandingStore;
  cfg: Record<string, unknown>;
  vector: VectorIndex;
  /** plugin context — needed by the LLM-driven AGENTS.md migration */
  ctx: Context;
  /**
   * Resolve the model route used by the migration planner. Called per request
   * because a route only exists after a session has issued a request; the
   * admin page can be opened before any session exists.
   */
  getRoute?: () => LlmRoute | undefined;
  /** absolute path to the active profile's cordis.patch.yml */
  profilePatch: string;
  log: (s: string) => void;
}

type MutateOutcome = { ok: true; message: string; entryCount?: number } | { ok: false; error: string };
type StoreChange = (list: DecodedEntry[]) => { next?: DecodedEntry[]; error?: string; message?: string };
type StandingChange = (list: string[]) => { next?: string[]; error?: string; message?: string };

/**
 * Build the /api/persona-memory route family.
 */
export function makeAdminRoutes(deps: AdminRouteDeps): WebRoute[] {
  const { store, standing, cfg, vector, profilePatch, log } = deps;

  /**
   * Guard helper: fence + method check.
   *
   * The accepted authorities are resolved per request (not cached at startup)
   * because a Cloudflare Quick Tunnel hostname changes on every restart; see
   * `resolveAllowedHosts`. The loopback peer check is always applied.
   */
  const guard = (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
    if (!isLoopbackRequest(req, resolveAllowedHosts(cfg))) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' });
      return false;
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      return false;
    }
    return true;
  };

  interface StoreSummary {
    exists: boolean;
    entries: number;
    chars: number;
    usagePct: number;
  }

  /** Store summaries for the status page. */
  function summarizeStores(): Record<string, StoreSummary> {
    const out: Record<string, StoreSummary> = {};
    for (const which of ['memory', 'user', 'failure'] as const) {
      const file = store.fileFor(which);
      const raw = readRaw(file);
      const limit = which === 'user' ? cfgNum(cfg, 'userCharLimit', 5000)
        : which === 'failure' ? cfgNum(cfg, 'failureCharLimit', cfgNum(cfg, 'memoryCharLimit', 5000) * 2)
          : cfgNum(cfg, 'memoryCharLimit', 5000);
      out[which] = raw === null
        ? { exists: false, entries: 0, chars: 0, usagePct: 0 }
        : {
            exists: true,
            entries: parseEntries(raw).length,
            chars: raw.length,
            usagePct: Math.min(100, Math.round((raw.length / limit) * 100)),
          };
    }
    return out;
  }

  /** Entry lists for the status page (raw text, decoded). */
  function listEntries(): Record<string, Array<{ text: string; created: string; lastReferenced: string; project: string | null }>> {
    const out: Record<string, Array<{ text: string; created: string; lastReferenced: string; project: string | null }>> = { memory: [], user: [], failure: [] };
    for (const which of Object.keys(out) as MemoryKind[]) {
      const raw = readRaw(store.fileFor(which));
      if (raw === null) continue;
      for (const entry of parseEntries(raw)) {
        const decoded = decodeEntry(entry);
        out[which].push({ text: decoded.text, created: decoded.created, lastReferenced: decoded.lastReferenced, project: decoded.project });
      }
    }
    return out;
  }

  /** Standing instructions (snapshot). */
  function standingSnapshot(): { exists: boolean; instructions: string[]; chars: number } {
    const raw = readRaw(standing.file);
    return raw === null ? { exists: false, instructions: [], chars: 0 } : {
      exists: true,
      instructions: parseInstructions(raw),
      chars: raw.length,
    };
  }

  /** Index file sizes. FTS lives beside the memory files; the vector index
   *  lives under vectorIndexDir (never inside the Pi-shared dir). */
  function statIndex(file: string): { exists: boolean; size: number } {
    try {
      const s = fs.statSync(file);
      return { exists: true, size: s.size };
    } catch {
      return { exists: false, size: 0 };
    }
  }
  const vectorIndexFile = (): string => path.join(
    cfgStr(cfg, 'vectorIndexDir', path.join(os.homedir(), '.dsh', 'memory')),
    '.memory-vec.sqlite',
  );

  /** Scan the local model cache directory for downloaded embedding models. */
  function listModels(): { dir: string; models: Array<{ name: string }> } {
    const dir = cfgStr(cfg, 'embeddingCacheDir', path.join(os.homedir(), '.dsh', 'models'));
    const models: Array<{ name: string }> = [];
    const walk = (base: string, prefix: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(base, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        const full = path.join(base, e.name);
        if (fs.existsSync(path.join(full, 'config.json'))) {
          models.push({ name: rel });
        } else {
          walk(full, rel);
        }
      }
    };
    walk(dir, '');
    return { dir, models };
  }

  interface ProjectEntryInfo {
    file: string;
    summary: string;
    exists: boolean;
    chars: number;
  }

  interface ProjectInfo {
    name: string;
    root: string;
    exists: boolean;
    resident: string[];
    residentChars: number;
    residentLimit: number;
    indexChars: number;
    indexLimit: number;
    entries: ProjectEntryInfo[];
    orphans: string[];
  }

  /**
   * List every registered project with its parsed AGENTS.md index.
   *
   * The registry (not a directory scan) is the source because a project's
   * memory lives inside the repository.
   */
  function listProjects(): ProjectInfo[] {
    const memoryDir = cfgStr(cfg, 'dir', resolveMemoryDir(cfg));
    const residentLimit = cfgNum(cfg, 'projectResidentCharLimit', 3000);
    const indexLimit = cfgNum(cfg, 'projectIndexCharLimit', 4000);
    return listRegistered(memoryDir).map((record: RegisteredProject): ProjectInfo => {
      const index: ProjectIndex = record.exists
        ? readIndex(record.root)
        : { root: record.root, agentsFile: path.join(record.root, 'AGENTS.md'), memoryDir: path.join(record.root, 'memory'), exists: false, resident: [], entries: [], orphans: [] };
      return {
        name: record.name,
        root: record.root,
        exists: record.exists,
        resident: index.resident,
        residentChars: residentChars(index.resident),
        residentLimit,
        indexChars: indexChars(index.entries),
        indexLimit,
        entries: index.entries.map((e) => ({ file: e.file, summary: e.summary, exists: e.exists, chars: e.chars })),
        orphans: index.orphans,
      };
    });
  }

  /**
   * Resolve a registry name to its absolute root.
   *
   * Every project route goes through this: the admin API must never accept a
   * path from the browser, or it becomes an arbitrary file read/write surface.
   *
   * @returns the root, or null when the name is unknown
   */
  function projectRoot(name: string): string | null {
    const memoryDir = cfgStr(cfg, 'dir', resolveMemoryDir(cfg));
    return rootForName(memoryDir, name);
  }

  /**
   * Current config = schema defaults -> resolved plugin cfg -> display fixes.
   * The resolved `cfg` layer is essential: without it the page shows defaults
   * for every key, and a save would then write those defaults back over the
   * user's real settings.
   */
  function currentConfig(): Record<string, unknown> {
    const picked: Record<string, unknown> = {};
    for (const f of CFG_SCHEMA) {
      if (f.key in cfg) picked[f.key] = cfg[f.key];
    }
    return Object.assign({}, CFG_DEFAULTS, picked, {
      dir: cfg.dir ?? '',
      vectorEnabled: cfg.vectorEnabled === true,
      embeddingProvider: cfg.embeddingProvider || 'remote',
      embeddingModel: cfg.embeddingModel || 'text-embedding-3-small',
      embeddingRemoteHost: cfg.embeddingRemoteHost || 'https://huggingface.co',
      embeddingCacheDir: cfg.embeddingCacheDir || '',
      // adminAllowedHosts is a string[] in the plugin, a comma string in the UI.
      adminAllowedHosts: Array.isArray(cfg.adminAllowedHosts) ? cfg.adminAllowedHosts.join(',') : (cfg.adminAllowedHosts ?? ''),
    });
  }

  /** Full status payload for the admin page. */
  function statusPayload(): Record<string, unknown> {
    const stores = summarizeStores();
    const standingInfo = standingSnapshot();
    const dir = resolveMemoryDir(cfg);
    return {
      dir,
      which: String(dir).includes('.pi') ? 'pi-shared' : 'dsh-only',
      config: currentConfig(),
      schema: CFG_SCHEMA,
      backupDir: BACKUP_BASE,
      backups: listBackups(),
      stores,
      standing: standingInfo,
      indexes: {
        fts: statIndex(path.join(dir, '.memory-index.sqlite')),
        vector: statIndex(vectorIndexFile()),
      },
      models: listModels(),
      projects: listProjects(),
      entries: listEntries(),
      ts: Date.now(),
    };
  }

  // ----------------------------------------------------------- mutations

  /**
   * Mutate one store by decoded-entry index.
   */
  async function mutateStore(which: string, change: StoreChange): Promise<MutateOutcome> {
    if (!['memory', 'user', 'failure'].includes(which)) return { ok: false, error: 'invalid which' };
    const file = store.fileFor(which as MemoryKind);
    const raw = readRaw(file);
    if (raw === null) return { ok: false, error: 'file not found' };
    const current = parseEntries(raw).map(decodeEntry);
    const outcome = change(current);
    if (outcome.error) return { ok: false, error: outcome.error };
    const next = outcome.next!.map((e) => encodeEntry(e.text, e.created, e.lastReferenced));
    const limit = which === 'user' ? cfgNum(cfg, 'userCharLimit', 5000)
      : which === 'failure' ? cfgNum(cfg, 'failureCharLimit', cfgNum(cfg, 'memoryCharLimit', 5000) * 2)
        : cfgNum(cfg, 'memoryCharLimit', 5000);
    const charCount = next.length ? next.join(ENTRY_DELIMITER).length : 0;
    if (charCount > limit) return { ok: false, error: `容量超限（${charCount} > ${limit}），请先合并或精简` };
    writeRawAtomic(file, next.length ? next.join(ENTRY_DELIMITER) : '');
    return { ok: true, message: outcome.message ?? `${which} 已更新（${next.length} 条）`, entryCount: next.length };
  }

  /** Mutate standing instructions. */
  async function mutateStanding(change: StandingChange): Promise<MutateOutcome> {
    const raw = readRaw(standing.file);
    const current = raw === null ? [] : parseInstructions(raw);
    const outcome = change(current);
    if (outcome.error) return { ok: false, error: outcome.error };
    const chars = outcome.next!.join('\n').length;
    const charLimit = cfgNum(cfg, 'standingCharLimit', 2000);
    if (chars > charLimit) return { ok: false, error: `超过 ${charLimit} 字符预算` };
    writeRawAtomic(standing.file, outcome.next!.length ? outcome.next!.join('\n') + '\n' : '');
    return { ok: true, message: outcome.message ?? `常驻指令已更新（${outcome.next!.length} 条）` };
  }

  // -------------------------------------------------------------- routes
  return [
    { kind: 'exact', path: '/api/persona-memory/status', handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guard(req, res, 'GET')) return;
      try {
        writeJson(res, 200, statusPayload());
      } catch (e) {
        writeJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    } },
    { kind: 'exact', path: '/api/persona-memory/projectGuide', handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guard(req, res, 'GET')) return;
      writeJson(res, 200, { guide: projectGuideText() });
    } },
    { kind: 'exact', path: '/api/persona-memory/checkModel', handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guard(req, res, 'GET')) return;
      const url = new URL(req.url ?? '/', 'http://localhost');
      const model = queryParam(url, 'model');
      if (!model) { writeJson(res, 200, { cached: false }); return; }
      const base = cfgStr(cfg, 'embeddingCacheDir', path.join(os.homedir(), '.dsh', 'models'));
      try {
        const cfgFile = path.join(base, ...model.split('/'), 'config.json');
        const cached = fs.existsSync(cfgFile);
        writeJson(res, 200, { cached, path: cached ? path.dirname(cfgFile) : undefined });
      } catch {
        writeJson(res, 200, { cached: false });
      }
    } },
    { kind: 'exact', path: '/api/persona-memory/configSave', handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guard(req, res, 'POST')) return;
      const body = await readJsonBody(req);
      if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return; }
      try {
        const cfgOut: Record<string, unknown> = {};
        for (const f of CFG_SCHEMA) {
          if (!(f.key in body)) continue;
          const raw = body[f.key];
          if (f.type === 'bool') cfgOut[f.key] = raw === 'false' ? false : !!raw;
          else if (f.type === 'number') {
            const n = raw === '' || raw === null || raw === undefined ? NaN : Number(raw);
            cfgOut[f.key] = Number.isFinite(n) ? n : undefined;
          }
          else cfgOut[f.key] = raw === null || raw === undefined ? '' : String(raw);
        }
        // adminAllowedHosts: the plugin expects string[]; the page edits a
        // comma-separated string. Write it back as a proper YAML list below.
        if (typeof cfgOut.adminAllowedHosts === 'string') {
          cfgOut.adminAllowedHosts = String(cfgOut.adminAllowedHosts)
            .split(',').map((x) => x.trim()).filter(Boolean);
        }
        if (cfgOut.embeddingModel !== undefined && !String(cfgOut.embeddingModel).trim()) {
          writeJson(res, 400, { error: '模型名不能为空' }); return;
        }
        if (!fs.existsSync(profilePatch)) { writeJson(res, 500, { error: `profile patch not found: ${profilePatch}` }); return; }
        const content = fs.readFileSync(profilePatch, 'utf8');
        const next = updateSectionConfig(content, 'persona-memory', cfgOut);
        writeRawAtomic(profilePatch, next);
        log(`admin: config saved to ${profilePatch}`);
        writeJson(res, 200, { ok: true, message: '配置已保存，重启 web 后生效' });
      } catch (e) {
        writeJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    } },
    { kind: 'exact', path: '/api/persona-memory/update', handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guard(req, res, 'POST')) return;
      const body = await readJsonBody(req);
      if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return; }
      const which = String(body.which || '');
      const index = Number(body.index);
      const text = String(body.text || '').trim();
      if (!text) { writeJson(res, 400, { error: '内容不能为空' }); return; }
      const result = await mutateStore(which, (list) => {
        if (!Number.isInteger(index) || index < 0 || index >= list.length) return { error: 'index out of range' };
        const updated = list.map((e, i) => i === index ? { ...e, text, lastReferenced: today() } : e);
        return { next: updated, message: `${which} 条目已更新` };
      });
      writeJson(res, result.ok ? 200 : 400, result);
    } },
    { kind: 'exact', path: '/api/persona-memory/delete', handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guard(req, res, 'POST')) return;
      const body = await readJsonBody(req);
      if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return; }
      const which = String(body.which || '');
      const index = Number(body.index);
      const result = await mutateStore(which, (list) => {
        if (!Number.isInteger(index) || index < 0 || index >= list.length) return { error: 'index out of range' };
        return { next: list.filter((_, i) => i !== index), message: `${which} 条目已删除` };
      });
      writeJson(res, result.ok ? 200 : 400, result);
    } },
    { kind: 'exact', path: '/api/persona-memory/projectRead', handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guard(req, res, 'POST')) return;
      const body = await readJsonBody(req);
      if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return; }
      const root = projectRoot(String(body.project || ''));
      if (!root) { writeJson(res, 404, { error: '未知项目' }); return; }
      const rel = safeMemoryRel(root, body.file);
      if (!rel) { writeJson(res, 400, { error: '非法记忆文件名' }); return; }
      const content = readMemoryFile(root, rel);
      if (content === null) { writeJson(res, 404, { error: `${rel} 不存在` }); return; }
      const summary = readIndex(root).entries.find((e) => e.file === rel)?.summary ?? '';
      writeJson(res, 200, { file: rel, summary, chars: content.length, content });
    } },
    { kind: 'exact', path: '/api/persona-memory/projectWrite', handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guard(req, res, 'POST')) return;
      const body = await readJsonBody(req);
      if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return; }
      const root = projectRoot(String(body.project || ''));
      if (!root) { writeJson(res, 404, { error: '未知项目' }); return; }
      const rel = safeMemoryRel(root, body.file);
      if (!rel) { writeJson(res, 400, { error: '非法记忆文件名' }); return; }
      const content = String(body.content ?? '');
      const blocked = cfgBool(cfg, 'enableSecretScanning', true) ? scanContent(content) : null;
      if (blocked) { writeJson(res, 400, { error: `内容被拒绝：${blocked}` }); return; }
      // A summary is optional here: editing a file's body must not silently
      // rewrite its index line, but supplying one updates it.
      const summary = typeof body.summary === 'string' ? body.summary : undefined;
      if (summary !== undefined) {
        const trimmed = summary.trim();
        const blockedSummary = scanContent(trimmed);
        if (blockedSummary) { writeJson(res, 400, { error: `描述被拒绝：${blockedSummary}` }); return; }
        const indexed = await mutateIndex(root, ({ resident, entries }) => {
          const exists = entries.some((e) => e.file === rel);
          const next = exists
            ? entries.map((e) => (e.file === rel ? { ...e, summary: trimmed } : e))
            : [...entries, { file: rel, summary: trimmed, exists: true, chars: 0 }];
          return { resident, entries: next };
        }, { residentCharLimit: cfgNum(cfg, 'projectResidentCharLimit', 3000), indexCharLimit: cfgNum(cfg, 'projectIndexCharLimit', 4000) });
        if (!indexed.ok) { writeJson(res, 400, { error: indexed.error }); return; }
      }
      const wrote = await writeMemoryFile(root, rel, content, cfgNum(cfg, 'projectFileCharLimit', 20000));
      if (!wrote.ok) { writeJson(res, 400, { error: wrote.error }); return; }
      log(`admin: wrote ${rel} in ${root}`);
      writeJson(res, 200, { ok: true, message: `${rel} 已保存（${wrote.chars} 字符）`, file: rel, chars: wrote.chars });
    } },
    { kind: 'exact', path: '/api/persona-memory/projectCreate', handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guard(req, res, 'POST')) return;
      const body = await readJsonBody(req);
      if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return; }
      const root = projectRoot(String(body.project || ''));
      if (!root) { writeJson(res, 404, { error: '未知项目' }); return; }
      const rel = safeMemoryRel(root, body.file);
      if (!rel) { writeJson(res, 400, { error: '非法记忆文件名（需以 .md 结尾）' }); return; }
      const summary = String(body.summary ?? '').trim();
      if (!summary) { writeJson(res, 400, { error: '描述不能为空' }); return; }
      const content = String(body.content ?? '');
      if (!content.trim()) { writeJson(res, 400, { error: '内容不能为空' }); return; }
      if (cfgBool(cfg, 'enableSecretScanning', true)) {
        const blocked = scanContent(content) ?? scanContent(summary);
        if (blocked) { writeJson(res, 400, { error: `内容被拒绝：${blocked}` }); return; }
      }
      const wrote = await writeMemoryFile(root, rel, content, cfgNum(cfg, 'projectFileCharLimit', 20000));
      if (!wrote.ok) { writeJson(res, 400, { error: wrote.error }); return; }
      const indexed = await mutateIndex(root, ({ resident, entries }) => ({
        resident,
        entries: entries.some((e) => e.file === rel)
          ? entries
          : [...entries, { file: rel, summary, exists: true, chars: content.length }],
      }), { residentCharLimit: cfgNum(cfg, 'projectResidentCharLimit', 3000), indexCharLimit: cfgNum(cfg, 'projectIndexCharLimit', 4000) });
      if (!indexed.ok) { writeJson(res, 400, { error: indexed.error }); return; }
      log(`admin: created ${rel} in ${root}`);
      writeJson(res, 200, { ok: true, message: `已新建 ${rel} 并加入索引`, file: rel });
    } },
    { kind: 'exact', path: '/api/persona-memory/projectDelete', handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guard(req, res, 'POST')) return;
      const body = await readJsonBody(req);
      if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return; }
      const root = projectRoot(String(body.project || ''));
      if (!root) { writeJson(res, 404, { error: '未知项目' }); return; }
      const rel = safeMemoryRel(root, body.file);
      if (!rel) { writeJson(res, 400, { error: '非法记忆文件名' }); return; }
      const removed = await deleteMemoryFile(root, rel);
      const cleared = await mutateIndex(root, ({ resident, entries }) => ({
        resident,
        entries: entries.filter((e) => e.file !== rel),
      }), { residentCharLimit: cfgNum(cfg, 'projectResidentCharLimit', 3000), indexCharLimit: cfgNum(cfg, 'projectIndexCharLimit', 4000) });
      if (!cleared.ok) { writeJson(res, 400, { error: cleared.error }); return; }
      log(`admin: deleted ${rel} in ${root}`);
      writeJson(res, 200, {
        ok: true,
        message: removed.ok ? `${rel} 已删除（移入 ${removed.trashed}）` : `${rel} 的索引已移除`,
        trashed: removed.ok ? removed.trashed : undefined,
      });
    } },
    { kind: 'exact', path: '/api/persona-memory/projectResident', handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guard(req, res, 'POST')) return;
      const body = await readJsonBody(req);
      if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return; }
      const root = projectRoot(String(body.project || ''));
      if (!root) { writeJson(res, 404, { error: '未知项目' }); return; }
      const text = String(body.content ?? '');
      if (cfgBool(cfg, 'enableSecretScanning', true)) {
        const blocked = scanContent(text);
        if (blocked) { writeJson(res, 400, { error: `内容被拒绝：${blocked}` }); return; }
      }
      const resident = text.split('\n').map((line) => line.replace(/\s+$/, ''));
      const result = await mutateIndex(root, ({ entries }) => ({ resident, entries }), {
        residentCharLimit: cfgNum(cfg, 'projectResidentCharLimit', 3000),
        indexCharLimit: cfgNum(cfg, 'projectIndexCharLimit', 4000),
      });
      if (!result.ok) { writeJson(res, 400, { error: result.error }); return; }
      log(`admin: updated resident block in ${root}`);
      writeJson(res, 200, { ok: true, message: `常驻区已保存（${residentChars(resident)} 字符）` });
    } },
    { kind: 'exact', path: '/api/persona-memory/projectMigrate', handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guard(req, res, 'POST')) return;
      const body = await readJsonBody(req);
      if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return; }
      const root = projectRoot(String(body.project || ''));
      if (!root) { writeJson(res, 404, { error: '未知项目' }); return; }
      try {
        const result = await migrateAgents(deps.ctx, root, deps.getRoute?.(), {
          apply: body.apply === true,
          scan: cfgBool(cfg, 'enableSecretScanning', true),
          fileCharLimit: cfgNum(cfg, 'projectFileCharLimit', 20000),
          residentCharLimit: cfgNum(cfg, 'projectResidentCharLimit', 3000),
          indexCharLimit: cfgNum(cfg, 'projectIndexCharLimit', 4000),
        });
        log(`admin: migrate ${root} -> ${result.migrated ? 'applied' : result.reason}`);
        // Always 200: a refused migration is a normal, repeatable outcome whose
        // reason the user needs to read. A 400 makes the page treat it as a
        // failed request and hides the explanation.
        writeJson(res, 200, result);
      } catch (e) {
        writeJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    } },
    { kind: 'exact', path: '/api/persona-memory/projectRegister', handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guard(req, res, 'POST')) return;
      const body = await readJsonBody(req);
      if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return; }
      const raw = String(body.root || '').trim();
      if (!raw || !path.isAbsolute(raw) || !fs.existsSync(raw)) { writeJson(res, 400, { error: '需要已存在的绝对路径' }); return; }
      // Normalize like the tool does: a pasted subdirectory must land on the
      // repository root, or the entry would point at a folder with no
      // AGENTS.md (`exists: false`) and the page would look broken.
      const normalized = resolveProjectRoot(raw);
      if (!normalized) {
        writeJson(res, 400, { error: '该路径不是项目（家目录 / 文件系统根目录），请填仓库路径' });
        return;
      }
      const memoryDir = cfgStr(cfg, 'dir', resolveMemoryDir(cfg));
      const record = registerProject(memoryDir, normalized);
      log(`admin: registered project ${record.name} -> ${record.root}`);
      const note = path.resolve(raw) !== normalized
        ? `（已从 ${raw} 归一化到仓库根 ${normalized}）`
        : '';
      writeJson(res, 200, { ok: true, message: `已登记 ${record.name}${note}`, project: record });
    } },
    { kind: 'exact', path: '/api/persona-memory/projectScan', handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guard(req, res, 'POST')) return;
      const body = await readJsonBody(req);
      if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return; }
      const raw = String(body.root || '').trim();
      if (!raw || !path.isAbsolute(raw) || !fs.existsSync(raw)) { writeJson(res, 400, { error: '需要已存在的绝对路径' }); return; }
      const memoryDir = cfgStr(cfg, 'dir', resolveMemoryDir(cfg));
      const scan = scanAndRegister(memoryDir, raw, {
        maxDepth: Number.isFinite(Number(body.maxDepth)) ? Number(body.maxDepth) : undefined,
        maxRepos: Number.isFinite(Number(body.maxRepos)) ? Number(body.maxRepos) : undefined,
      });
      log(`admin: scanned ${raw} -> ${scan.roots.length} repos (${scan.added.length} new)`);
      const parts = [`扫描到 ${scan.roots.length} 个仓库`, `新增 ${scan.added.length}`];
      if (scan.existing.length) parts.push(`已存在 ${scan.existing.length}`);
      if (scan.truncated) parts.push('已达上限，提前停止');
      writeJson(res, 200, {
        ok: true,
        message: parts.join('，'),
        ...scan,
      });
    } },
    { kind: 'exact', path: '/api/persona-memory/backup', handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guard(req, res, 'POST')) return;
      try {
        const result = await backupAll(cfg);
        writeJson(res, 200, result);
      } catch (e) {
        writeJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    } },
    { kind: 'exact', path: '/api/persona-memory/restoreLatest', handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guard(req, res, 'POST')) return;
      try {
        const count = await restoreFromLatest(cfg);
        log(`admin: restored ${count} files from latest backup`);
        writeJson(res, 200, { ok: true, message: `已从最新备份恢复 ${count} 个文件 → ${resolveMemoryDir(cfg)}` });
      } catch (e) {
        writeJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    } },
    { kind: 'exact', path: '/api/persona-memory/standingAdd', handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guard(req, res, 'POST')) return;
      const body = await readJsonBody(req);
      if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return; }
      const text = normalizeInstruction(String(body.text || '').trim());
      if (!text) { writeJson(res, 400, { error: '指令不能为空' }); return; }
      const result = await mutateStanding((list) => {
        if (list.some((x) => x.toLowerCase() === text.toLowerCase())) return { error: '该指令已存在' };
        const maxEntries = cfgNum(cfg, 'standingMaxEntries', 20);
        if (list.length >= maxEntries) return { error: `常驻指令上限 ${maxEntries} 条` };
        return { next: [...list, text], message: `已添加常驻指令（共 ${list.length + 1} 条）` };
      });
      writeJson(res, result.ok ? 200 : 400, result);
    } },
    { kind: 'exact', path: '/api/persona-memory/standingUpdate', handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guard(req, res, 'POST')) return;
      const body = await readJsonBody(req);
      if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return; }
      const index = Number(body.index);
      const text = normalizeInstruction(String(body.text || '').trim());
      if (!text) { writeJson(res, 400, { error: '指令不能为空' }); return; }
      const result = await mutateStanding((list) => {
        if (!Number.isInteger(index) || index < 0 || index >= list.length) return { error: 'index out of range' };
        if (list.some((x, i) => i !== index && x.toLowerCase() === text.toLowerCase())) return { error: '该指令已存在' };
        const next = list.slice();
        next[index] = text;
        return { next, message: '常驻指令已更新' };
      });
      writeJson(res, result.ok ? 200 : 400, result);
    } },
    { kind: 'exact', path: '/api/persona-memory/standingRemove', handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guard(req, res, 'POST')) return;
      const body = await readJsonBody(req);
      if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return; }
      const index = Number(body.index);
      const result = await mutateStanding((list) => {
        if (!Number.isInteger(index) || index < 0 || index >= list.length) return { error: 'index out of range' };
        return { next: list.filter((_, i) => i !== index), message: '常驻指令已删除' };
      });
      writeJson(res, result.ok ? 200 : 400, result);
    } },
    { kind: 'exact', path: '/api/persona-memory/rebuildVector', handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guard(req, res, 'POST')) return;
      try {
        const file = vectorIndexFile();
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
        log('admin: vector index cleared');
        writeJson(res, 200, { ok: true, message: '向量索引已清空，下次 memory_search 会自动重建' });
      } catch (e) {
        writeJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    } },
  ];
}

/**
 * Resolve the active profile's cordis.patch.yml for config write-back.
 */
export function profilePatchPath(profileName: string): string {
  return path.join(os.homedir(), '.dsh', 'profiles', profileName, 'cordis.patch.yml');
}

// ------------------------------------------------------- auto-protect

export interface AutoProtectDeps {
  cfg: Record<string, unknown>;
  /** absolute path to profile patch */
  profilePatch: string;
  log: (s: string) => void;
  /** injected timer (ctx.timer.interval) */
  setInterval: (fn: () => void, delay: number) => () => void;
}

/**
 * Start the background auto-protect tick: periodic backup (autoBackupMin)
 * + Pi-loss detection (autoSwitchOnPiLoss). Returns a disposer.
 */
export function startAutoProtect(deps: AutoProtectDeps): () => void {
  const { cfg, profilePatch, log, setInterval } = deps;
  let piSeen = false;
  let switched = false;
  let lastAutoBackupAt = 0;

  const tick = async (): Promise<void> => {
    try {
      const patch = readRaw(profilePatch);
      const patchCfg = patch ? parseSectionConfig(patch, 'persona-memory') : {};
      const backupMin = Number(patchCfg.autoBackupMin ?? cfg.autoBackupMin ?? CFG_DEFAULTS.autoBackupMin);
      const switchOnLoss = patchCfg.autoSwitchOnPiLoss !== false && cfg.autoSwitchOnPiLoss !== false;

      const dir = resolveMemoryDir(cfg);
      const isPi = String(dir).includes('.pi');
      const piMem = path.join(os.homedir(), '.pi', 'agent', 'pi-hermes-memory', 'MEMORY.md');
      const piExists = fs.existsSync(piMem);

      if (isPi && piExists) piSeen = true;
      if (switchOnLoss && isPi && piSeen && !piExists && !switched) {
        switched = true;
        const localDir = path.join(os.homedir(), '.dsh', 'memory');
        log('Pi memory lost — switching to local dir + restore from latest backup');
        if (fs.existsSync(profilePatch)) {
          const content = fs.readFileSync(profilePatch, 'utf8');
          const next = updateSectionConfig(content, 'persona-memory', { dir: localDir });
          writeRawAtomic(profilePatch, next);
        }
        await restoreFromLatest(cfg, localDir);
      }

      if (backupMin > 0) {
        const now = Date.now();
        if (now - lastAutoBackupAt >= backupMin * 60 * 1000) {
          lastAutoBackupAt = now;
          await backupAll(cfg);
        }
      }
    } catch (err) {
      log(`auto-protect tick error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  tick();
  return setInterval(() => { tick(); }, 60 * 1000);
}
