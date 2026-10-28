/**
 * dsh-persona-memory — persistent long-term persona memory for DeepSeek Harness.
 *
 * - Storage: MEMORY.md + USER.md, ON-DISK FORMAT SHARED WITH pi-hermes-memory
 *   (entries joined by "\n§\n", metadata in trailing HTML comments), so DSH
 *   and Pi can read and write the same memory files.
 * - Tools: `memory` (read/add/update/delete/rewrite) and `memory_search`,
 *   registered through the harness tool registry.
 * - Injection: per-request system-prompt section (order 55) rendering the
 *   current memory block bounded by memoryCharLimit/userCharLimit.
 * - Safety: every write passes the hermes content scanner (prompt-injection
 *   /exfiltration payloads, credentials, invisible unicode are rejected).
 *
 * Default store directory resolution:
 *   1. explicit `dir` config
 *   2. the Pi hermes data dir when it already has MEMORY.md (share memory)
 *   3. <dshHome>/memory
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { createEmbeddingProvider } from './lib/embedding.js';
import { registerLifecycleHooks, type LearningConfig } from './lib/learning.js';
import { renderRecentFailures } from './lib/failures.js';
import { createMemoryStore, type MemoryStore } from './lib/memory-store.js';
import { registerMemorySearchTool } from './lib/memory-search-tool.js';
import { registerMemoryTool, type MemoryToolConfig } from './lib/memory-tool.js';
import { registerProjectMemoryTool } from './lib/project-memory-tool.js';
import { type LlmRoute } from './lib/llm-helper.js';
import { readIndex, resolveProjectRoot, type ProjectIndex } from './lib/project-memory.js';
import { projectBootstrapBlock, projectCoreLines, projectHasMemory } from './lib/project-guide.js';
import { findGitRepoRoot } from './lib/projects.js';
import { registerProject } from './lib/project-registry.js';
import { makeAdminRoutes, profilePatchPath, startAutoProtect } from './lib/admin.js';
import { renderMemoryBlock } from './lib/prompt.js';
import { createFtsIndex } from './lib/fts.js';
import { createVectorIndex } from './lib/vector-index.js';
import { allowsInjection, sessionOf } from './lib/sessions.js';
import { registerStandingCommand } from './lib/standing-command.js';
import { createStandingStore, type StandingStore } from './lib/standing.js';
import type { Context } from '@deepseek-ai/cordis';

export const name = 'dsh-persona-memory';

/** Services required by this plugin (harness host plane). */
export const inject = ['tools', 'systemPrompt', 'commands', 'webServer', 'llm'];

const PI_HERMES_DIR = path.join(os.homedir(), '.pi', 'agent', 'pi-hermes-memory');

export interface PluginConfig {
  dir?: string;
  memoryCharLimit: number;
  userCharLimit: number;
  enableSecretScanning: boolean;
  inject: boolean;
  /** Only inject the memory blocks into human-driven sessions (not subagents). */
  injectHumanOnly: boolean;
  sectionOrder: number;
  searchMaxResults: number;
  usageNudgeThreshold: number;
  correctionDetection: boolean;
  correctionPatternDetection: boolean;
  /** Only run correction detection in human-driven sessions. */
  correctionHumanOnly: boolean;
  correctionRateLimitTurns: number;
  learnEnabled: boolean;
  /** Only run background learning in human-driven sessions. */
  learnHumanOnly: boolean;
  learnIntervalTurns: number;
  learnRecentTurns: number;
  learnMaxChars: number;
  learnTimeoutMs: number;
  autoConsolidate: boolean;
  consolidateStaleDays: number;
  consolidateTimeoutMs: number;
  standingEnabled: boolean;
  standingCharLimit: number;
  standingMaxEntries: number;
  failureInjectionEnabled: boolean;
  failureMaxAgeDays: number;
  failureMaxEntries: number;
  failureCharLimit: number;
  projectEnabled: boolean;
  projectFileCharLimit: number;
  projectResidentCharLimit: number;
  projectIndexCharLimit: number;
  projectAutoMigrate: boolean;
  /** Inject the "start a project memory" hint in repositories that have none. */
  projectBootstrapHint: boolean;
  memoryFtsEnabled: boolean;
  vectorEnabled: boolean;
  vectorIndexDir: string;
  embeddingProvider: string;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  embeddingModel: string;
  embeddingCacheDir: string;
  embeddingRemoteHost: string;
  adminProfile: string;
  /**
   * Extra authorities the admin API accepts besides loopback literals, for
   * deployments reached through a tunnel or reverse proxy (the browser then
   * sends the public hostname in `Host`, which the loopback fence rejects).
   * The TCP peer must still be loopback — this only names the authority the
   * already-local connection may claim. Match on `host[:port]`, lowercase.
   */
  adminAllowedHosts: string[];
  /**
   * File holding the currently advertised public URL (default: the Cloudflare
   * Quick Tunnel URL file shared with `dsh-web-run.sh`). Re-read per request,
   * so a tunnel restart — which changes the hostname — needs no config edit
   * and no plugin reload. Set to `''` to rely on `adminAllowedHosts` alone.
   */
  adminAllowedHostsFile: string;
  autoBackupMin: number;
  autoSwitchOnPiLoss: boolean;
  /** Loose extras accepted from the patch/config (schema-driven admin page). */
  [key: string]: unknown;
}

function resolveDir(cfg: { dir?: string } | undefined): string {
  if (cfg?.dir) return cfg.dir;
  // Share memory with Pi's pi-hermes-memory when that store already exists.
  if (fs.existsSync(path.join(PI_HERMES_DIR, 'MEMORY.md'))) return PI_HERMES_DIR;
  return dshHomePath('memory');
}

/**
 * The session's effective working directory.
 *
 * The working-directory service is authoritative (a session can change
 * directory mid-flight); the immutable session header is the fallback for
 * contexts where the service is unavailable (e.g. tests).
 */
function cwdFromSession(ctx: Context, session: unknown): string | null {
  const carrier = session as { header?: { cwd?: string } } | undefined;
  try {
    const service = ctx.get('workingDirectory') as { get?: (s: unknown) => string } | undefined;
    const fromService = service?.get?.(session);
    if (typeof fromService === 'string' && fromService) return fromService;
  } catch {
    /* service unavailable — fall through to the header */
  }
  return carrier?.header?.cwd ?? null;
}

/**
 * Per-request index cache keyed by AGENTS.md mtime+size.
 *
 * The system-prompt variable provider is synchronous and runs on every
 * request, so re-parsing AGENTS.md unconditionally would put a synchronous
 * read on the hot path. A changed mtime or size invalidates the entry; the
 * file is small, so a stale-by-one-write window is the only risk and the next
 * request reparses.
 */
const indexCache = new Map<string, { key: string; index: ProjectIndex }>();

/** @returns the parsed index for `root`, reusing it while AGENTS.md is unchanged */
function readIndexCached(root: string): ProjectIndex {
  const file = path.join(root, 'AGENTS.md');
  let key = 'missing';
  try {
    const stat = fs.statSync(file);
    key = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    key = 'missing';
  }
  const cached = indexCache.get(root);
  if (cached && cached.key === key) return cached.index;
  const index = readIndex(root);
  indexCache.set(root, { key, index });
  return index;
}

/**
 * The project block injected into every request.
 *
 * The pointer lines themselves are NOT repeated here: `agent-instructions`
 * already injects AGENTS.md verbatim. This adds what the file cannot say about
 * itself — what the two zones are for, how to load a topic, and how to write
 * new knowledge — plus the pointer lines only when the harness' discovery
 * root differs from ours (a linked worktree, where agent-instructions roots at
 * the worktree while memory lives at the main repository root).
 *
 * Empty projects get the bootstrap variant instead: without it a fresh
 * repository never learns that this protocol exists, which is precisely how
 * project memory used to stay empty.
 */
function renderProjectBlock(root: string, index: ProjectIndex, cwd: string): string {
  if (!projectHasMemory(index)) return projectBootstrapBlock(root);
  const core = projectCoreLines();
  const covered = harnessInstructionRoot(cwd) === root;
  // Chinese on purpose: the guide (and the resident rules it competes with in
  // a Chinese-language repository) is Chinese, and one block must not switch
  // languages halfway through.
  if (covered) {
    // AGENTS.md is already in context (resident rules AND pointer lines), so
    // repeating the pointers would only burn tokens. Add the convention that
    // the pointers are lazy (nothing here is loaded until the model reads it)
    // and the authoring rules that keep the split intact as it grows.
    return [
      '### 项目记忆',
      '本仓库的长期记忆在 `AGENTS.md`（已在上方注入）：非 `@` 行是常驻规则，末尾的 `@memory/*.md` 行是主题文件索引。',
      '主题文件不在上下文里——做那类工作前先用 `project_memory read`（或 `read`）读进来。',
      ...core,
    ].join('\n');
  }
  // The harness did not load this AGENTS.md, so neither the pointers nor the
  // resident rules are in context. This is the linked-worktree case:
  // agent-instructions roots at the worktree (it holds the `.git` marker file)
  // while the memory lives at the main repository root. Emit both here.
  const topics = index.entries.map((e) => `${e.file}${e.summary ? ` — ${e.summary}` : ''}`);
  const lines = [
    '### 项目记忆',
    `本仓库的长期记忆在 \`${root}\`，但当前工作目录下宿主的自动注入没带上它，所以这里补一份。`,
    '主题文件不在上下文里，做那类工作前先用 `project_memory read`（或 `read`）读进来：',
    ...topics.map((t) => `- ${t}`),
    ...core,
  ];
  const resident = index.resident.join('\n').trim();
  if (resident) lines.push('', '#### 常驻规则（来自 AGENTS.md）', resident);
  return lines.join('\n');
}

/**
 * Where the harness' own instruction discovery roots this cwd: the nearest
 * ancestor that contains a `.git` entry (either a directory or the pointer
 * file of a linked worktree), or cwd itself when there is none. Mirrors
 * `@deepseek-ai/dsh-agent-instructions` so the two agree on AGENTS.md scope.
 */
function harnessInstructionRoot(cwd: string): string {
  let current = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
}

export function apply(ctx: Context, config?: Record<string, unknown>): void {
  const cfg: PluginConfig = {
    dir: resolveDir(config),
    memoryCharLimit: 5000,
    userCharLimit: 5000, // aligned with pi-hermes-memory DEFAULT_USER_CHAR_LIMIT
    enableSecretScanning: true,
    inject: true,
    // Derived sessions (subagent / workflow child / AgentTeams member) do not
    // see the persona memory block; they inherit context from their parent.
    injectHumanOnly: true,
    sectionOrder: 55,
    searchMaxResults: 10,
    // usage reporting + consolidation nudge
    usageNudgeThreshold: 0.9,
    // correction detection on feedback/record + in-chat pattern detection
    correctionDetection: true,
    correctionPatternDetection: true,
    correctionHumanOnly: true,
    correctionRateLimitTurns: 3,
    // background learning every N turns via the session's own LLM route
    learnEnabled: true,
    learnHumanOnly: true,
    learnIntervalTurns: 10,
    learnRecentTurns: 2,
    learnMaxChars: 6000,
    learnTimeoutMs: 120000,
    // auto-consolidation when a store exceeds its char limit (LLM merge,
    // committed only when strictly smaller and scanner-clean)
    autoConsolidate: true,
    consolidateStaleDays: 30,
    consolidateTimeoutMs: 120000,
    // standing instructions (STANDING.md, always injected, user-authored only)
    standingEnabled: true,
    standingCharLimit: 2000,
    standingMaxEntries: 20,
    // failure memory (failures.md): recent failures injected every request
    failureInjectionEnabled: true,
    failureMaxAgeDays: 7,
    failureMaxEntries: 5,
    failureCharLimit: 10000, // hermes: failures get memoryCharLimit * 2
    // project memory (projects-memory/<name>/MEMORY.md, Pi-compatible root)
    projectEnabled: true,
    // 单个 memory/<topic>.md 的字符上限（主题拆分后每个文件可以比全局记忆大）
    projectFileCharLimit: 20000,
    // AGENTS.md 常驻区字符预算：只放操作性硬约束，细节进 memory/
    projectResidentCharLimit: 3000,
    // AGENTS.md 索引区（@memory/... 行）字符预算
    projectIndexCharLimit: 4000,
    // 已有 prose AGENTS.md 时是否允许辅助 LLM 自动改造成常驻+索引
    projectAutoMigrate: true,
    // 无记忆的 git 仓库里是否注入「怎么建项目记忆」的引导（否则新项目永远
    // 不知道有这套机制）
    projectBootstrapHint: true,
    // FTS5 memory mirror (Extended Store): full-text ranking for memory_search
    memoryFtsEnabled: true,
    // Semantic (vector) memory search: a DSH-side SQLite cache storing ONLY
    // embeddings for the shared Markdown files. Fingerprint-incremental: Pi's
    // writes to MEMORY.md/USER.md/failures.md are picked up on next search.
    // Off by default; enable with vectorEnabled + an embedding provider.
    vectorEnabled: false,
    // Directory for the derived vector index. Kept under the DSH home (never
    // inside the Pi-shared memory dir) so Pi never sees or touches it. The
    // index is disposable — drop it and it rebuilds from the Markdown files.
    vectorIndexDir: dshHomePath('memory'),
    embeddingProvider: 'remote', // 'remote' (OpenAI-compatible API) | 'local' (transformers.js)
    embeddingBaseUrl: '',
    embeddingApiKey: '', // falls back to DSH_EMBEDDING_API_KEY env
    embeddingModel: 'text-embedding-3-small',
    // local provider: model auto-downloads to embeddingCacheDir on first use
    embeddingCacheDir: '', // default: $DSH_HOME/models
    embeddingRemoteHost: 'https://huggingface.co', // mirror: https://hf-mirror.com
    // admin settings page: profile whose cordis.patch.yml receives config writes
    adminProfile: 'web',
    // Extra Host authorities accepted by the admin API besides loopback
    // (e.g. a Cloudflare Quick Tunnel hostname). Empty = strict loopback only.
    adminAllowedHosts: [],
    // Quick Tunnel URL file (same one dsh-web-run.sh reads for --trusted-host).
    adminAllowedHostsFile: '/var/lib/cloudflared/dsh-url.txt',
    // auto-protect: periodic backup (minutes; 0=off) + Pi-loss fallback
    autoBackupMin: 60,
    autoSwitchOnPiLoss: true,
    ...(config as Partial<PluginConfig> | undefined),
  };
  cfg.dir = resolveDir(config); // explicit config.dir wins; defaults re-resolved

  const memoryDir = cfg.dir;
  const store = createMemoryStore({
    dir: memoryDir,
    limits: {
      memory: cfg.memoryCharLimit,
      user: cfg.userCharLimit,
      failure: cfg.failureCharLimit ?? cfg.memoryCharLimit * 2,
    },
  });
  const standing: StandingStore = createStandingStore({
    dir: cfg.dir,
    maxEntries: cfg.standingMaxEntries,
    maxChars: cfg.standingCharLimit,
  });
  const fts = createFtsIndex({ dir: cfg.dir, enabled: cfg.memoryFtsEnabled });
  const embedding = createEmbeddingProvider({
    ...cfg,
    logger: ctx.logger,
  });
  const vector = createVectorIndex({
    dir: cfg.vectorIndexDir ?? dshHomePath('memory'),
    enabled: cfg.vectorEnabled,
    provider: embedding,
  });

  registerMemoryTool(ctx, store, cfg as MemoryToolConfig);
  registerMemorySearchTool(ctx, store, cfg, fts, vector);
  registerLifecycleHooks(ctx, store, cfg as LearningConfig);

  // 最近一次请求用过的模型路由。辅助 LLM 特性（学习、合并、迁移）都复用它；
  // 管理页可能在任何会话出现之前被打开，所以这里按事件更新、按需读取。
  let lastRoute: LlmRoute | undefined;
  ctx.on('session/event', (_session, event) => {
    if (event.type !== 'request/header') return;
    const config = event.data?.header?.config;
    if (config?.provider && config?.model) lastRoute = { provider: config.provider, model: config.model };
  });

  // 项目记忆：AGENTS.md（常驻区 + @ 指针索引）+ memory/ 主题文件。
  // 作用域 = 会话工作目录所属的 git 仓库根（worktree 共享），无 project 参数。
  if (cfg.projectEnabled) {
    const cwdOf = (exec: { agent?: { session?: unknown } }): string | null => {
      const session = exec.agent?.session;
      if (!session) return null;
      return cwdFromSession(ctx, session);
    };
    registerProjectMemoryTool(ctx, {
      config: {
        projectFileCharLimit: cfg.projectFileCharLimit,
        projectResidentCharLimit: cfg.projectResidentCharLimit,
        projectIndexCharLimit: cfg.projectIndexCharLimit,
        projectAutoMigrate: cfg.projectAutoMigrate,
        enableSecretScanning: cfg.enableSecretScanning,
        searchMaxResults: cfg.searchMaxResults,
        memoryDir: cfg.dir,
      },
      cwdOf: cwdOf as never,
    });
  }

  // 记忆管理设置页（browser half）：/api/persona-memory/* 路由。
  // 配置写回目标 = 当前 profile 的 cordis.patch.yml 中 persona-memory 段。
  if (ctx.webServer) {
    const profileName = cfg.adminProfile ?? 'web';
    const routes = makeAdminRoutes({
      store,
      standing,
      vector,
      cfg,
      ctx,
      getRoute: () => lastRoute,
      profilePatch: profilePatchPath(profileName),
      log: (s) => ctx.logger.info(s),
    });
    // 注册必须挂在 effect 里：webServer.register 不像 tools.register /
    // systemPrompt.section 那样自动绑定当前 fiber。不包 effect 时，插件被热重载
    // （改 cordis.patch.yml、重装、HMR）后旧路由仍留在 webServer 表里，第二次
    // apply 第一条就撞 `duplicate exact route` → 新 fiber FAILED（插件卡片显示
    // "启动失败"），而旧路由继续服务（"记忆管理"页却照常能用），同时 memory
    // 工具其实没注册上。
    ctx.effect(() => {
      const disposers = routes.map((route) => ctx.webServer.register(route));
      return () => {
        for (const dispose of disposers.reverse()) dispose();
      };
    });

    // 自动保护：定时备份（autoBackupMin 分钟一次，只保留最新一份）+ Pi
    // 记忆丢失自动切换（Pi 的 MEMORY.md 曾存在但消失 → 切到本地 + 恢复）。
    // ctx.timer 是 Cordis 提供的 timer 服务，宿主侧可用；兜底 node setInterval。
    const timerService = ctx.get('timer');
    const disposer = startAutoProtect({
      cfg,
      profilePatch: profilePatchPath(profileName),
      log: (s) => ctx.logger.info(s),
      setInterval: (fn, delay) => {
        if (timerService) return timerService.interval(fn, delay);
        const handle = setInterval(fn, delay);
        return () => clearInterval(handle);
      },
    });
    ctx.effect(() => disposer);
  }

  if (cfg.standingEnabled) {
    registerStandingCommand(ctx, standing);
  }

  if (cfg.inject) {
    /** Derived sessions (subagent / workflow child / team member) skip injection. */
    const hidden = (context: unknown): boolean => !allowsInjection(cfg, sessionOf(context));
    if (cfg.standingEnabled) {
      ctx.systemPrompt.variable('standing_block', (context) => (hidden(context) ? '' : standing.readSyncBlock()));
      ctx.systemPrompt.section({
        name: 'memory:standing',
        order: Math.max(0, cfg.sectionOrder - 5),
        text: '{{standing_block}}',
      });
    }
    if (cfg.failureInjectionEnabled) {
      ctx.systemPrompt.variable('failures_block', (context) => (hidden(context) ? '' : renderRecentFailures(store, cfg)));
      ctx.systemPrompt.section({
        name: 'memory:failures',
        order: Math.max(0, cfg.sectionOrder - 3),
        text: '{{failures_block}}',
      });
    }
    if (cfg.projectEnabled) {
      ctx.systemPrompt.variable('project_block', (context) => {
        if (hidden(context)) return '';
        const session = sessionOf(context) as { header?: { cwd?: string } } | undefined;
        const cwd = session ? cwdFromSession(ctx, session) : null;
        if (!cwd) return '';
        const root = resolveProjectRoot(cwd);
        if (!root) return '';
        const index = readIndexCached(root);
        // `exists` gates too: a `memory/` directory with no AGENTS.md has no
        // resident rules and no index, so there is nothing to load yet.
        const hasMemory = index.exists && projectHasMemory(index);
        // Bootstrap only inside a real git repository: an arbitrary scratch
        // directory has no shared memory to grow, and telling the model to
        // start one there would just produce files nobody reads again.
        if (!hasMemory) {
          if (!cfg.projectBootstrapHint) return '';
          if (findGitRepoRoot(cwd) === null) return '';
          // Do NOT register here: the registry lists projects that HAVE
          // memory, and merely opening a repository is not a reason to fill
          // the admin page with rows pointing at nothing.
          return renderProjectBlock(root, index, cwd);
        }
        registerProject(memoryDir, root);
        return renderProjectBlock(root, index, cwd);
      });
      ctx.systemPrompt.section({
        name: 'memory:project',
        order: Math.max(0, cfg.sectionOrder - 2),
        text: '{{project_block}}',
      });
    }
    // The whole block (heading + instructions + rendered memory) lives in the
    // variable so a derived session contributes nothing at all.
    ctx.systemPrompt.variable('memory_profile', (context) => {
      if (hidden(context)) return '';
      return [
        '## Persistent persona memory',
        'You have a persistent long-term memory stored on disk that survives across sessions, shared with your other agent instances. It is managed through the `memory` tool and searched with `memory_search`.',
        'Keep it current: record durable facts about the user, their preferences, project conventions, and environment details; update or delete entries when they change. User corrections and periodic reviews are captured automatically, but you should still save important facts immediately via `memory add`. Never store credentials — writes are scanned and rejected.',
        'Current memory:',
        renderMemoryBlock(store, cfg),
      ].join('\n\n');
    });
    ctx.systemPrompt.section({
      name: 'memory:profile',
      order: cfg.sectionOrder,
      text: '{{memory_profile}}',
    });
  }
}

export default { apply, inject, name };
