/**
 * dsh-persona-memory — browser half ("记忆管理" settings page).
 *
 * This is the SOURCE for the prebuilt client bundle (client/client.js),
 * compiled by scripts/build-client.mjs (esbuild) with `react` externalized —
 * the emitted require("react") binds to the ModuleLoader's factory require.
 * Only React and plain browser globals (fetch/URLSearchParams/setTimeout) —
 * no Node builtins, no bundler transform.
 *
 * The page talks to the host through the /api/persona-memory/* route family
 * (registered by lib/admin.ts on the host `webServer` service).
 *
 * Export contract (matches the shipped ui-* plugins):
 *   - inject: ['slots'] — the settings.section slot is contributed via
 *     `ctx.slots.inject` (dsh-client-ui-slots).
 *   - apply(ctx) — registers the page.
 */
import * as React from 'react';

// ------------------------------------------------------------- types

interface EntryItem {
  text: string;
  created: string;
  project: string | null;
  /** Whether this entry falls inside the injection window (newest ones do). */
  inInjectionWindow?: boolean;
}

interface SchemaFieldClient {
  key: string;
  type: string;
  label: string;
  group: string;
  help?: string;
  options?: string[];
}

interface StatusPayload {
  dir: string;
  which: string;
  config: Record<string, unknown>;
  schema?: SchemaFieldClient[];
  backupDir: string;
  /** Snapshot list: `latest` (the live mirror) first, then dated snapshots newest first. */
  backups: BackupSnapshot[];
  /** How many dated snapshots are retained (`backupKeep`; 0 = latest-only). */
  backupKeep?: number;
  stores: Record<string, { exists: boolean; entries: number; chars: number }>;
  standing: { exists: boolean; instructions: string[]; chars: number };
  indexes: { fts: { exists: boolean; size: number }; vector: { exists: boolean; size: number } };
  models: { dir: string; models: Array<{ name: string }> };
  projects: ProjectInfo[];
  entries: Record<string, EntryItem[]>;
  /** Whether the host has a session or configured default route for migration planning. */
  llmRouteAvailable?: boolean;
  /** The actual provider/model the planner will use (for the UI hint). */
  llmRoute?: { provider: string; model: string } | null;
  /** A migration currently occupying the host's single-flight slot. */
  migration?: MigrationStatus | null;
  ts: number;
}

interface MigrationStatus {
  active: boolean;
  project?: string;
  stage?: string;
  /** Host's human-readable stage detail (model route, file count, reason…). */
  detail?: string;
  startedAt?: number;
  elapsedMs?: number;
  finishedAt?: number;
  outcome?: 'completed' | 'refused' | 'failed';
  reason?: string;
  written?: string[];
  backup?: string;
}

interface EditingState {
  which: string;
  index: number;
  text: string;
}

/** One restore source listed by the host (`GET /status`). */
interface BackupSnapshot {
  /** `latest` for the live mirror, else the dated snapshot dir stamp. */
  name: string;
  kind: 'latest' | 'history';
  files: number;
  /** Snapshot creation time (ISO); '' when unknown. */
  mtime: string;
  restorable: boolean;
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

/** Open-file editor state for one project topic file. */
interface ProjectFileEditState {
  project: string;
  file: string;
  summary: string;
  content: string;
}

/** Resident-block editor state for one project. */
interface ProjectResidentEditState {
  project: string;
  content: string;
}

/** New-topic-file draft. */
interface ProjectCreateState {
  project: string;
  file: string;
  summary: string;
  content: string;
}

interface StandingEditState {
  index: number;
  text: string;
}

interface ModelStatusState {
  checking?: boolean;
  cached?: boolean;
  path?: string;
}

/** One in-flight host mutation. A counter, not a boolean: a short overlapping
 *  request must never clear the busy state of a long migration. */
interface PendingTask {
  label: string;
  startedAt: number;
}

// ------------------------------------------------------------- api

/** One JSON call to the host route family. */
async function api(path: string, payload?: unknown, method?: string): Promise<any> {
  const res = await fetch('/api/persona-memory' + path, payload === undefined && method === undefined
    ? undefined
    : {
        method: method || 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* non-empty non-JSON body is handled below */
  }
  if (!res.ok) {
    const message = body && body.error ? body.error : 'HTTP ' + res.status;
    // 404 on an admin route almost always means the running host process is
    // older than the installed package: the page is newer than the host. Say
    // so, instead of showing a bare "HTTP 404" that reads like a broken URL.
    if (res.status === 404) {
      throw new Error(message + ' —— 该接口在运行中的宿主里不存在，通常是重装插件后没重启 dsh web（页面比宿主新）。重启 web 后重试。');
    }
    throw new Error(message);
  }
  return body;
}

/**
 * Hand a Blob to the browser as a download.
 *
 * Everything is feature-detected: the admin page also renders in the
 * bundle-contract test (no `document`, no `URL.createObjectURL`), where this
 * must be a no-op instead of a crash. Returns false when the download could
 * not be started, so the caller can tell the user to use the raw route.
 */
function saveBlob(blob: Blob, filename: string): boolean {
  try {
    const doc = typeof document !== 'undefined' ? document : undefined;
    const canUrl = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
    if (!doc || !canUrl) return false;
    const url = URL.createObjectURL(blob);
    const a = doc.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    doc.body.appendChild(a);
    a.click();
    doc.body.removeChild(a);
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* already gone */ } }, 10_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Turn a failed binary/raw upload response into the same actionable message
 * `api()` gives, from the JSON error body when there is one.
 *
 * Why this exists: export/import bypass `api()` (one response is a zip, the
 * other a raw byte body), so they used to surface a bare "HTTP 404". A 404 on
 * an admin route almost always means the running host is older than the
 * installed package — the exact confusion that made a working button look
 * broken — so both paths must explain it identically.
 */
function rawRequestError(status: number, body: any): Error {
  const detail = body && (body.error || body.message) ? String(body.error || body.message) : '';
  if (status === 404) {
    return new Error((detail ? detail + ' —— ' : '') + '该接口在运行中的宿主里不存在，通常是重装插件后没重启 dsh web（页面比宿主新）。重启 web 后重试。');
  }
  return new Error(detail || 'HTTP ' + status);
}

/** `demo-memory-20261108-231502.zip` — mirrors the host's naming so both agree. */
function archiveFileName(project: string): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const safe = (project || 'project').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  return `${safe}-memory-${stamp}.zip`;
}

// ----------------------------------------------------------- helpers

function fmtBytes(n: number | undefined | null): string {
  if (!n && n !== 0) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

/** Actions that can take a while (LLM planning) get a distinct, honest label. */
const ACTION_LABELS: Record<string, string> = {
  projectMigrate: '迁移旧 AGENTS.md',
  projectScan: '扫描目录',
  rebuildVector: '重建向量索引',
  backup: '立即备份',
  restoreLatest: '恢复备份',
  configSave: '保存配置',
  prune: '清理旧条目',
  consolidate: '整理记忆',
};

function actionLabel(action: string): string {
  return ACTION_LABELS[action] || '保存';
}

/** Human-friendly host stage names. Unknown/new stages pass through as-is. */
const STAGE_LABELS: Record<string, string> = {
  starting: '准备迁移',
  checking: '检查 AGENTS.md 形态',
  planning: '调用模型规划拆分',
  validating: '校验计划（标题保全 / 主题粒度 / 预算 / 路径）',
  writing: '写入主题文件与索引',
  completed: '迁移完成',
  refused: '迁移被拒绝',
  failed: '迁移失败',
};

function stageLabel(stage?: string): string {
  return stage ? (STAGE_LABELS[stage] || stage) : '';
}

/** `已等待 1 分 03 秒` — proves the long request is still alive. */
function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min > 0 ? `已等待 ${min} 分 ${String(sec).padStart(2, '0')} 秒` : `已等待 ${sec} 秒`;
}

/**
 * Shared button renderer. `disabled` is forwarded to the DOM button, so a
 * click during an in-flight mutation cannot fire its handler at all (the old
 * "处理中" refresh button was still clickable and re-ran the load).
 */
function btn(
  label: React.ReactNode,
  onClick: () => void,
  opts?: { disabled?: boolean; style?: React.CSSProperties; title?: string },
): React.ReactElement {
  const disabled = !!(opts && opts.disabled);
  return React.createElement('button', {
    onClick: disabled ? undefined : onClick,
    disabled,
    title: opts && opts.title,
    style: Object.assign({
      padding: '5px 12px',
      borderRadius: 6,
      fontSize: 13,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
    }, opts && opts.style),
  }, label);
}

/** `2026-11-01T05:44:50.123Z` → local `2026-11-01 13:44:50`. */
function fmtStamp(iso: string): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Local calendar day for "N days ago" (`YYYY-MM-DD`, comparable to `created`). */
function dayBefore(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function input(value: unknown, onChange: (v: string) => void, placeholder?: string, disabled?: boolean): React.ReactElement {
  return React.createElement('input', {
    value: value === undefined || value === null ? '' : (value as string | number),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value),
    placeholder,
    disabled,
    style: {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 10px',
      borderRadius: 6,
      fontSize: 13,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      opacity: disabled ? 0.6 : 1,
    },
  });
}

function numberInput(value: unknown, onChange: (v: string) => void, placeholder?: string, disabled?: boolean): React.ReactElement {
  return React.createElement('input', {
    type: 'number',
    value: value === undefined || value === null ? '' : (value as string | number),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value),
    placeholder,
    disabled,
    style: {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 10px',
      borderRadius: 6,
      fontSize: 13,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      opacity: disabled ? 0.6 : 1,
    },
  });
}

// 编辑用多行输入框：按内容高度自动展开，完整显示全部文字。
// 最小 3 行，最大 300px 内滚动；内容变化时重新测量。
// 必须是独立组件：hooks（useRef/useLayoutEffect）归属组件自身，
// 写成普通函数会在条件渲染时崩 React error #310。
function TextArea(props: { value: string; onChange: (v: string) => void; placeholder?: string; disabled?: boolean }): React.ReactElement {
  const ref = React.useRef<HTMLTextAreaElement | null>(null);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 300) + 'px';
  }, [props.value]);
  return React.createElement('textarea', {
    ref,
    value: props.value,
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => props.onChange(e.target.value),
    placeholder: props.placeholder,
    rows: 3,
    disabled: props.disabled,
    style: {
      width: '100%',
      boxSizing: 'border-box',
      padding: '8px 10px',
      borderRadius: 6,
      fontSize: 13,
      lineHeight: 1.5,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      resize: 'vertical',
      minHeight: 68,
      maxHeight: 300,
      overflowY: 'auto',
      fontFamily: 'inherit',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      opacity: props.disabled ? 0.6 : 1,
    },
  });
}

/**
 * File input for the memory-archive import.
 *
 * Opens the OS file dialog on mount so one click on 「导入记忆包」 is enough, and
 * stays a plain <input type=file> in every environment that lacks
 * `HTMLInputElement.click()` (the bundle-contract test renders it directly).
 */
function ArchiveFileInput(props: { onPick: (file: File) => void; disabled?: boolean }): React.ReactElement {
  const ref = React.useRef<HTMLInputElement | null>(null);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (el && typeof el.click === 'function') {
      try { el.click(); } catch { /* some browsers block programmatic pickers */ }
    }
  }, []);
  return React.createElement('input', {
    ref,
    type: 'file',
    accept: '.zip,application/zip',
    disabled: props.disabled,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files && e.target.files[0];
      if (f) props.onPick(f);
    },
    style: { fontSize: 12, padding: '4px 0', color: 'var(--dsw-alias-label-primary)' },
  });
}

function meter(pct: number): React.ReactElement {
  return React.createElement('div', {
    style: { height: 4, background: 'var(--dsw-alias-border-l1)', borderRadius: 2, overflow: 'hidden', margin: '4px 0 6px' },
  },
    React.createElement('div', {
      style: {
        height: 4,
        width: pct + '%',
        background: pct >= 90 ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)',
        borderRadius: 2,
        transition: 'width 0.3s',
      },
    }),
  );
}

// ------------------------------------------------------- persisted ui state

/**
 * Collapse/expand state survives reloads: readers expect the page to open the
 * way they left it (e.g. 项目记忆 expanded last time stays expanded next
 * launch). All disclosure states share one localStorage entry so future shapes
 * stay in one place; any parse failure / storage error falls back to defaults.
 */
const UI_STATE_KEY = 'persona-memory.ui';

/** Defaults match the old hardcoded values (resident/常驻指令 style cards open, reference cards closed). */
const DEFAULT_OPEN: Record<string, boolean> = { standing: true, files: true, indexes: true, projects: false, backups: true, config: false };

interface UiState {
  open: Record<string, boolean>;
  /** project name whose card is expanded (accordion, null = none) */
  projOpen: string | null;
  /** per-project resident-block disclosure map */
  residentOpen: Record<string, boolean>;
  /** per-config-group disclosure map inside the 插件配置 card; missing key = expanded */
  configGroups: Record<string, boolean>;
}

function loadUiState(): UiState {
  try {
    const raw = window.localStorage.getItem(UI_STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UiState>;
      return {
        open: parsed.open && typeof parsed.open === 'object' ? Object.assign({}, DEFAULT_OPEN, parsed.open) : DEFAULT_OPEN,
        projOpen: typeof parsed.projOpen === 'string' ? parsed.projOpen : null,
        residentOpen: parsed.residentOpen && typeof parsed.residentOpen === 'object' ? parsed.residentOpen : {},
        configGroups: parsed.configGroups && typeof parsed.configGroups === 'object' ? parsed.configGroups : {},
      };
    }
  } catch { /* private mode or corrupt value: fall through to defaults */ }
  return { open: DEFAULT_OPEN, projOpen: null, residentOpen: {}, configGroups: {} };
}

// ------------------------------------------------------------- page

function MemAdminPage(): React.ReactElement {
  const [state, setState] = React.useState<StatusPayload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  /** In-flight requests, keyed by an incrementing id. Never a boolean: an
   *  overlapping short load must not clear a long migration's busy state. */
  const [pending, setPending] = React.useState<Record<number, PendingTask>>({});
  const [ticker, setTicker] = React.useState(0);
  const nextTaskId = React.useRef(0);
  const [editing, setEditing] = React.useState<EditingState | null>(null);
  const [confirmDel, setConfirmDel] = React.useState<EditingState | null>(null);
  /** Inline "delete entries older than N days" draft (one store at a time). */
  const [pruneDraft, setPruneDraft] = React.useState<{ which: string; days: string } | null>(null);
  /** Second click: show the exact count before running the destructive prune. */
  const [pruneConfirm, setPruneConfirm] = React.useState<{ which: string; days: number; count: number; cutoff: string } | null>(null);
  const [olderOpen, setOlderOpen] = React.useState<Record<string, boolean>>({});
  const [consolidateConfirm, setConsolidateConfirm] = React.useState<string | null>(null);
  const [initialUi] = React.useState(loadUiState);
  const [projOpen, setProjOpen] = React.useState<string | null>(initialUi.projOpen);
  /** Resident block is collapsed by default: it is a reference panel, and
   *  expanded it visually ran into the index list below it. */
  const [residentOpen, setResidentOpen] = React.useState<Record<string, boolean>>(initialUi.residentOpen);
  const [projEdit, setProjEdit] = React.useState<ProjectFileEditState | null>(null);
  const [projResidentEdit, setProjResidentEdit] = React.useState<ProjectResidentEditState | null>(null);
  const [projCreate, setProjCreate] = React.useState<ProjectCreateState | null>(null);
  const [projConfirm, setProjConfirm] = React.useState<{ project: string; file: string } | null>(null);
  /** Project whose inline "选择压缩包" picker is open (import flow). */
  const [archivePick, setArchivePick] = React.useState<string | null>(null);
  const [newProjectPath, setNewProjectPath] = React.useState('');
  /** parent directory to scan for repositories */
  const [scanPath, setScanPath] = React.useState('');
  /** authoring guide panel (fetched once on first expand; host owns the text) */
  const [guide, setGuide] = React.useState<{ open: boolean; text: string | null; loading: boolean }>({ open: false, text: null, loading: false });
  const [standingEdit, setStandingEdit] = React.useState<StandingEditState | null>(null);
  const [newStanding, setNewStanding] = React.useState('');
  const [open, setOpen] = React.useState<Record<string, boolean>>(initialUi.open);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [cfgForm, setCfgForm] = React.useState<Record<string, unknown> | null>(null);
  /** config-group disclosure inside 插件配置; missing key = expanded (schema-driven groups are mostly read top-down) */
  const [cfgGroupsOpen, setCfgGroupsOpen] = React.useState<Record<string, boolean>>(initialUi.configGroups);
  const [modelStatus, setModelStatus] = React.useState<ModelStatusState | null>(null);
  /** Pending restore confirmation: the snapshot NAME the user clicked. */
  const [confirmRestore, setConfirmRestore] = React.useState<string | null>(null);
  /** Live migration progress from the host; null until the first poll. */
  const [migration, setMigration] = React.useState<MigrationStatus | null>(null);
  /** Last result shown in the progress strip; cleared by the next action. */
  const [lastOutcome, setLastOutcome] = React.useState<MigrationStatus | null>(null);

  const pendingList = Object.values(pending);
  const busy = pendingList.length > 0;
  const activeTask = pendingList[0];
  const activeMigration = !!(migration && migration.active);
  const migrationStage = stageLabel(migration ? migration.stage : undefined);

  /** Add one tracked in-flight request; returns its disposer. */
  const track = (label: string): (() => void) => {
    const id = ++nextTaskId.current;
    const task: PendingTask = { label, startedAt: Date.now() };
    setPending((prev) => Object.assign({}, prev, { [id]: task }));
    return () => setPending((prev) => {
      const next = Object.assign({}, prev);
      delete next[id];
      return next;
    });
  };

  // A one-second ticker keeps the "已等待 N 秒" line honest during a long LLM
  // call, and drives the lightweight migration-progress poll. No timer when
  // nothing is in flight, so an idle page stays idle.
  React.useEffect(() => {
    if (!busy && !activeMigration) return;
    const timer = window.setInterval(() => setTicker((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [busy, activeMigration]);

  /** Ask the host for the migration's real stage (it owns the LLM call). */
  const pollMigration = React.useCallback(async () => {
    try {
      const res = await api('/projectMigrateStatus', undefined, 'GET');
      const next: MigrationStatus = (res && res.migration) || { active: false };
      // Status polls once a second; only write state when it actually changed,
      // or a long migration would re-render the whole page every tick.
      setMigration((prev) => JSON.stringify(prev) === JSON.stringify(next) ? prev : next);
      const route = !!(res && res.llmRouteAvailable);
      const nextRoute = (res && res.llmRoute) || null;
      setState((prev) => prev
        && (prev.llmRouteAvailable !== route || JSON.stringify(prev.llmRoute || null) !== JSON.stringify(nextRoute))
        ? Object.assign({}, prev, { llmRouteAvailable: route, llmRoute: nextRoute }) : prev);
      // Keep the finished stage visible until the next action: the notice can
      // be dismissed, but the strip should still say why a run stopped.
      if (!next.active && next.finishedAt && next.stage) setLastOutcome((prev) => JSON.stringify(prev) === JSON.stringify(next) ? prev : next);
    } catch {
      // An older host without this route is not a page failure: the in-flight
      // mutation's own response still carries the outcome.
    }
  }, []);
  React.useEffect(() => {
    if (busy || activeMigration) pollMigration();
  }, [busy, activeMigration, ticker, pollMigration]);

  const load = React.useCallback(async () => {
    const done = track('读取状态');
    setError(null);
    try {
      const s = await api('/status', undefined, 'GET');
      setState(s as StatusPayload);
      if (s && s.migration) setMigration(s.migration);
      if (s && s.config && Array.isArray(s.schema)) {
        const next: Record<string, unknown> = {};
        for (const f of s.schema as SchemaFieldClient[]) {
          if (!(f.key in s.config)) continue;
          const v = s.config[f.key];
          next[f.key] = f.type === 'number'
            ? (v === undefined || v === null ? '' : v)
            : (v === undefined || v === null ? '' : v);
        }
        // fallbacks so the form never shows blanks for the common ones
        if (!('embeddingModel' in next) || next.embeddingModel === '') next.embeddingModel = 'Xenova/bge-small-zh-v1.5';
        if (!('embeddingProvider' in next) || next.embeddingProvider === '') next.embeddingProvider = 'local';
        if (!('embeddingRemoteHost' in next) || next.embeddingRemoteHost === '') next.embeddingRemoteHost = 'https://huggingface.co';
        setCfgForm(next);
      }
    } catch (e) {
      const message = String((e && (e as Error).message) || e);
      // Only the very first load has no cards to keep: show the old dedicated
      // error page with a retry button. A later failed refresh keeps the cards
      // visible and surfaces the reason in the notice strip.
      setState((prev) => {
        if (!prev) setError(message);
        else setNotice('刷新失败: ' + message);
        return prev;
      });
    } finally {
      done();
    }
  }, []);
  React.useEffect(() => { load(); }, [load]);

  // Persist disclosure state so the next visit reopens the cards the way the
  // user left them. Skip the very first render (no change to write yet).
  const mountedRef = React.useRef(false);
  React.useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    try {
      window.localStorage.setItem(UI_STATE_KEY, JSON.stringify({ open, projOpen, residentOpen, configGroups: cfgGroupsOpen } satisfies UiState));
    } catch { /* storage full/blocked: persistence is best-effort */ }
  }, [open, projOpen, residentOpen, cfgGroupsOpen]);

  // Debounced model-cache check while typing (400ms). In the browser
  // half the global setTimeout is available; keep a cleanup disposer so
  // an unmount never resolves into a dead setState.
  const modelName = cfgForm ? String(cfgForm.embeddingModel ?? '') : '';
  React.useEffect(() => {
    if (!modelName || !modelName.trim()) return;
    setModelStatus({ checking: true });
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        const res = await api('/checkModel?model=' + encodeURIComponent(modelName.trim()), undefined, 'GET');
        if (alive) setModelStatus({ checking: false, cached: !!(res && res.cached), path: res && res.path });
      } catch {
        if (alive) setModelStatus({ checking: false, cached: false });
      }
    }, 400);
    return () => { alive = false; clearTimeout(timer); };
  }, [modelName]);

  /** A refused migration is a completed request, not "完成". */
  const migrationOutcome = (res: any): string => {
    if (res && res.migrated === true) {
      const parts = ['迁移完成'];
      if (res.written && res.written.length) parts.push(`新建 ${res.written.length} 个主题文件`);
      if (res.backup) parts.push(`原文备份为 ${res.backup}`);
      return parts.join('：');
    }
    if (res && res.migrated === false) return '未迁移：' + (res.reason || '计划未通过校验');
    return (res && res.message) || '完成';
  };

  const mutate = async (action: string, payload?: unknown) => {
    if (busy) return; // single-flight guard: no double writes on a fast double click
    const label = action === 'projectMigrate'
      ? `迁移 ${String((payload as { project?: string } | undefined)?.project || 'AGENTS.md')}`
      : actionLabel(action);
    const done = track(label);
    setError(null);
    setNotice(null);
    setLastOutcome(null);
    try {
      const res = await api('/' + action, payload || {});
      if (res && res.error) setNotice('操作失败: ' + res.error);
      else if (action === 'projectMigrate') setNotice(migrationOutcome(res));
      // Mutations that report success:false carry a human-readable `reason`
      // (e.g. the migration planner's output failing a gate) — show it as the
      // outcome rather than a generic "完成".
      else if (res && res.ok === false && res.reason) setNotice('未完成：' + res.reason);
      else setNotice((res && res.message) || '完成');
      setEditing(null);
      setConfirmDel(null);
      setPruneDraft(null);
      setPruneConfirm(null);
      setConsolidateConfirm(null);
      setProjEdit(null);
      setProjResidentEdit(null);
      setProjCreate(null);
      setProjConfirm(null);
      setArchivePick(null);
      setNewProjectPath('');
      setScanPath('');
      setStandingEdit(null);
      setNewStanding('');
      setConfirmRestore(null);
    } catch (e) {
      // A failed mutation is a normal outcome: keep the cards visible so the
      // user can read the reason and retry. Only a failed initial LOAD blanks
      // the page (see `load`).
      setNotice(action === 'projectMigrate' ? '迁移失败：' : '操作失败：' + String((e && (e as Error).message) || e));
    } finally {
      await load(); // refresh the cards; its own counter cannot clear this task
      await pollMigration();
      done();
    }
  };

  const saveConfig = async () => {
    if (!cfgForm || busy) return;
    const done = track('保存配置');
    setError(null);
    setNotice(null);
    try {
      const res = await api('/configSave', cfgForm);
      if (res && res.error) setNotice('保存失败: ' + res.error);
      else setNotice((res && res.message) || '配置已保存');
    } catch (e) {
      setNotice('操作失败: ' + String((e && (e as Error).message) || e));
    } finally {
      await load();
      done();
    }
  };

  /** Read-only fetch helpers also join the busy counter: opening an editor
   *  while a migration runs would otherwise let two state refreshes race. */
  const openProjectFile = async (proj: ProjectInfo, file: string) => {
    if (busy) return;
    const done = track('读取记忆文件');
    setError(null);
    try {
      const res = await api('/projectRead', { project: proj.name, file });
      setProjEdit({ project: proj.name, file, summary: String(res.summary || ''), content: String(res.content || '') });
      setProjResidentEdit(null);
      setProjCreate(null);
    } catch (e) {
      setNotice('读取失败：' + String((e && (e as Error).message) || e));
    } finally {
      done();
    }
  };

  /**
   * Export one project's memory as a zip and trigger a browser download.
   *
   * Not routed through `mutate()`: the response is BINARY, so `api()` (which
   * always parses JSON) would throw on the successful path. The request still
   * joins the busy counter so the page-wide lock behaves like every other call.
   */
  const exportProject = async (proj: ProjectInfo) => {
    if (busy) return;
    const done = track('导出记忆包');
    setError(null);
    setNotice(null);
    setLastOutcome(null);
    try {
      const res = await fetch('/api/persona-memory/projectExport', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: proj.name }),
      });
      if (!res.ok) {
        let body: any = null;
        try { body = await res.json(); } catch { /* non-JSON error body */ }
        throw rawRequestError(res.status, body);
      }
      const blob = await res.blob();
      const headerName = res.headers && typeof res.headers.get === 'function' ? res.headers.get('x-archive-filename') : '';
      const filename = headerName || archiveFileName(proj.name);
      const saved = saveBlob(blob, filename);
      setNotice(saved
        ? `已导出 ${filename}（${fmtBytes(blob.size)}）：在另一台机器用「导入记忆包」选它即可还原该项目的记忆`
        : `已生成 ${filename}（${fmtBytes(blob.size)}），但浏览器未允许自动下载；请换用 Chrome/Edge 再试`);
    } catch (e) {
      setNotice('导出失败：' + String((e && (e as Error).message) || e));
    } finally {
      done();
    }
  };

  /** Import a chosen zip into `project` (archive read happens host-side). */
  const importProject = async (project: string, file: File) => {
    if (busy) return;
    const done = track('导入记忆包');
    setError(null);
    setNotice(null);
    setLastOutcome(null);
    try {
      const buffer = await file.arrayBuffer();
      const res = await fetch('/api/persona-memory/projectImport?project=' + encodeURIComponent(project), {
        method: 'POST',
        headers: { 'content-type': 'application/zip' },
        body: buffer,
      });
      let body: any = null;
      try { body = await res.json(); } catch { /* empty body */ }
      if (!res.ok) throw rawRequestError(res.status, body);
      const warnings = body && Array.isArray(body.warnings) && body.warnings.length
        ? '（注意：' + body.warnings.join('；') + '）'
        : '';
      setNotice(((body && body.message) || '导入完成') + warnings);
      setProjOpen(project);
    } catch (e) {
      setNotice('导入失败：' + String((e && (e as Error).message) || e));
    } finally {
      done();
      await load(); // the index / resident block / topic list all changed
    }
  };

  if (error) {
    return React.createElement('div', { style: { maxWidth: 720 } },
      React.createElement('div', { style: { fontWeight: 600, marginBottom: 8 } }, '记忆管理'),
      React.createElement('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 13 } }, '读取失败: ' + error),
      React.createElement('button', { onClick: load, style: { marginTop: 8 } }, '重试'),
    );
  }
  if (!state) {
    return React.createElement('div', { style: { maxWidth: 720 } },
      React.createElement('div', { style: { fontWeight: 600, marginBottom: 8 } }, '记忆管理'),
      React.createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, busy ? '读取中...' : '正在加载'),
    );
  }

  const st = state.stores || {};
  const idx = state.indexes || {};
  const m = state.models || {};
  const standing = (state.standing || {}).instructions || [];
  const projects = state.projects || [];
  const backups = state.backups || [];
  const whichName: Record<string, string> = { memory: 'MEMORY.md', user: 'USER.md' };
  const routeAvailable = state.llmRouteAvailable === true;
  // An active migration blocks every other action, even if this tab did not
  // start it (the host is single-flight).
  const locked = busy || activeMigration;
  const elapsed = activeTask ? Date.now() - activeTask.startedAt : 0;

  /** A button that obeys the page-wide lock without repeating the flag at
   *  every call site. Locally disabled buttons stay disabled. */
  const actionBtn = (
    label: React.ReactNode,
    onClick: () => void,
    opts?: { disabled?: boolean; style?: React.CSSProperties; title?: string },
  ): React.ReactElement => btn(label, onClick, Object.assign({}, opts, {
    disabled: locked || !!(opts && opts.disabled),
    // Keep an explicit local disable (e.g. already-migrated) visually dimmer
    // than a mere busy lock, unless the caller set its own opacity.
    style: Object.assign({}, opts && opts.style, locked && !(opts && opts.disabled) ? { opacity: 0.5 } : {}),
  }));

  const card = (key: string, title: string, summary: string | null, children: React.ReactNode): React.ReactElement => {
    const isOpen = open[key];
    return React.createElement('div', { style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, marginBottom: 10, overflow: 'hidden', background: 'var(--dsw-alias-bg-layer-1)' } },
      React.createElement('div', {
        onClick: () => setOpen(Object.assign({}, open, { [key]: !isOpen })),
        style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', cursor: 'pointer', userSelect: 'none' },
      },
        React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', transition: 'transform 0.2s', transform: isOpen ? 'rotate(90deg)' : 'none' } }, '\u25B8'),
        React.createElement('span', { style: { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, title),
        React.createElement('span', { style: { flex: 1 } }),
        summary ? React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, summary) : null,
      ),
      isOpen ? React.createElement('div', { style: { padding: '4px 14px 14px', borderTop: '1px solid var(--dsw-alias-border-l1)' } }, children) : null,
    );
  };

  /** One memory entry: text, created date, edit/delete actions. */
  const entryRow = (which: string, entry: EntryItem, i: number): React.ReactNode => {
    const isEditing = editing && editing.which === which && editing.index === i;
    const isConfirm = confirmDel && confirmDel.which === which && confirmDel.index === i;
    if (isEditing) {
      return React.createElement('div', { key: which + i, style: { padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
        React.createElement(TextArea, { value: editing.text, onChange: (v) => setEditing({ which, index: i, text: v }), placeholder: '条目内容', disabled: locked }),
        React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
          actionBtn('保存', () => mutate('update', { which, index: i, text: editing.text })),
          actionBtn('取消', () => setEditing(null)),
        ),
      );
    }
    if (isConfirm) {
      return React.createElement('div', { key: which + i, style: { padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
        React.createElement('div', { style: { color: 'var(--dsw-alias-state-warn-primary)', fontSize: 13, marginBottom: 6 } }, '确认删除这条记忆？'),
        React.createElement('div', { style: { display: 'flex', gap: 8 } },
          actionBtn('删除', () => mutate('delete', { which, index: i }), { style: { background: 'var(--dsw-alias-state-error-primary)', borderColor: 'transparent', color: '#fff' } }),
          actionBtn('取消', () => setConfirmDel(null)),
        ),
      );
    }
    return React.createElement('div', { key: which + i, style: { padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 } },
      React.createElement('div', { style: { flex: 1, minWidth: 0 } },
        React.createElement('div', { style: { fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, entry.text),
        React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 3 } },
          `创建 ${entry.created || '-'}`,
        ),
      ),
      React.createElement('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
        actionBtn('编辑', () => setEditing({ which, index: i, text: String(entry.text || '') }), { style: { padding: '3px 8px', fontSize: 12 } }),
        actionBtn('删除', () => setConfirmDel({ which, index: i, text: String(entry.text || '') }), { style: { padding: '3px 8px', fontSize: 12 } }),
      ),
    );
  };

  /**
   * Entries shown split by the injection window: the ones the model actually
   * sees come first, older ones live behind a disclosure so the page still
   * exposes the whole file without implying it is all injected.
   */
  const entryRows = (which: string): React.ReactNode => {
    const list = (state.entries || {})[which] || [];
    if (list.length === 0) {
      return React.createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', padding: '6px 0' } }, '（无条目）');
    }
    const visible: Array<{ entry: EntryItem; index: number }> = [];
    const older: Array<{ entry: EntryItem; index: number }> = [];
    list.forEach((entry, index) => (entry.inInjectionWindow === false ? older : visible).push({ entry, index }));
    const openOlder = olderOpen[which] === true;
    return React.createElement('div', null,
      visible.map(({ entry, index }) => entryRow(which, entry, index)),
      older.length
        ? React.createElement('div', { key: 'older-' + which, style: { marginTop: 4 } },
            actionBtn(
              `${openOlder ? '收起' : '展开'}更早的 ${older.length} 条记忆（不注入提示词，仍然保存、可搜索）`,
              () => setOlderOpen(Object.assign({}, olderOpen, { [which]: !openOlder })),
              { style: { padding: '3px 8px', fontSize: 12 } },
            ),
            openOlder ? older.map(({ entry, index }) => entryRow(which, entry, index)) : null,
          )
        : null,
    );
  };

  const standingRows = (): React.ReactNode => {
    if (standing.length === 0) return React.createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, '（无常驻指令）');
    return standing.map((text, i) => {
      const isEditing = standingEdit && standingEdit.index === i;
      if (isEditing) {
        return React.createElement('div', { key: 's' + i, style: { padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
          React.createElement(TextArea, { value: standingEdit.text, onChange: (v) => setStandingEdit({ index: i, text: v }), disabled: locked }),
          React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
            actionBtn('保存', () => mutate('standingUpdate', { index: i, text: standingEdit.text })),
            actionBtn('取消', () => setStandingEdit(null)),
          ),
        );
      }
      return React.createElement('div', { key: 's' + i, style: { padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 } },
        React.createElement('span', { style: { flex: 1, fontSize: 13, whiteSpace: 'pre-wrap' } }, text),
        React.createElement('div', { style: { display: 'flex', gap: 6 } },
          actionBtn('编辑', () => setStandingEdit({ index: i, text }), { style: { padding: '3px 8px', fontSize: 12 } }),
          actionBtn('删除', () => mutate('standingRemove', { index: i }), { style: { padding: '3px 8px', fontSize: 12 } }),
        ),
      );
    });
  };

  /**
   * Inline "delete entries older than N days" control for one store.
   *
   * Two steps on purpose: the draft only picks a cutoff, and the confirm shows
   * the exact entry count before anything is written. The host snapshots the
   * whole store into `<dir>/.trash/` before deleting, so this stays undoable.
   */
  /** Manual merge: rewrites the file only when the result is strictly smaller. */
  const consolidateControl = (which: string): React.ReactNode => {
    if (consolidateConfirm === which) {
      return React.createElement('div', { style: { marginTop: 6, fontSize: 13 } },
        React.createElement('div', { style: { color: 'var(--dsw-alias-state-warn-primary)', marginBottom: 6 } },
          `确认用模型整理 ${whichName[which]}？会合并相似条目、保留偏好与「用户纠正」条目；只有结果更小且通过扫描才写入，原文件可事后从备份恢复。`),
        React.createElement('div', { style: { display: 'flex', gap: 8 } },
          actionBtn('确认整理', () => mutate('consolidate', { which })),
          actionBtn('取消', () => setConsolidateConfirm(null)),
        ),
      );
    }
    return React.createElement('div', { style: { marginTop: 4 } },
      actionBtn('整理记忆（合并相似条目）', () => setConsolidateConfirm(which), { style: { padding: '3px 8px', fontSize: 12 } }),
    );
  };

  const pruneControl = (which: string): React.ReactNode => {
    const list = (state.entries || {})[which] || [];
    if (pruneDraft && pruneDraft.which === which) {
      const days = Number(pruneDraft.days);
      const valid = Number.isInteger(days) && days >= 1 && days <= 3650;
      const cutoff = valid ? dayBefore(days) : '';
      const count = valid ? list.filter((e) => String(e.created || '').slice(0, 10) < cutoff).length : 0;
      return React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 6, fontSize: 13 } },
        React.createElement('span', null, '删除创建于'),
        input(pruneDraft.days, (v) => setPruneDraft({ which, days: v }), '天数'),
        React.createElement('span', null, '天前的条目'),
        React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } },
          valid ? `（created 早于 ${cutoff}：${count} 条）` : '（天数需为 1–3650 的整数）'),
        actionBtn('下一步', () => {
          if (!valid) { setNotice('天数需为 1–3650 的整数'); return; }
          if (count === 0) { setNotice(`没有创建早于 ${cutoff} 的条目`); return; }
          setPruneConfirm({ which, days, count, cutoff });
          setPruneDraft(null);
        }),
        actionBtn('取消', () => setPruneDraft(null)),
      );
    }
    if (pruneConfirm && pruneConfirm.which === which) {
      return React.createElement('div', { style: { marginTop: 6, fontSize: 13 } },
        React.createElement('div', { style: { color: 'var(--dsw-alias-state-warn-primary)', marginBottom: 6 } },
          `确认删除 ${whichName[which]} 中创建早于 ${pruneConfirm.cutoff} 的 ${pruneConfirm.count} 条？删除前会自动在 .trash/ 留一份快照。`),
        React.createElement('div', { style: { display: 'flex', gap: 8 } },
          actionBtn('确认删除', () => mutate('prune', { which, days: pruneConfirm.days }), { style: { background: 'var(--dsw-alias-state-error-primary)', borderColor: 'transparent', color: '#fff' } }),
          actionBtn('取消', () => setPruneConfirm(null)),
        ),
      );
    }
    return React.createElement('div', { style: { marginTop: 4 } },
      actionBtn('清理旧条目', () => { setPruneDraft({ which, days: '30' }); setPruneConfirm(null); }, { style: { padding: '3px 8px', fontSize: 12 } }),
    );
  };

  const filesBody = (): React.ReactElement => React.createElement('div', null,
    (['memory', 'user'] as const).map((which) => {
      const info = st[which] || {};
      return React.createElement('div', { key: which, style: { padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 } },
          React.createElement('span', { style: { fontWeight: 600, minWidth: 96 } }, whichName[which]),
          React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)' } },
            info.exists ? `${info.entries} 条 · ${info.chars} 字符（仅最近部分注入提示词）` : '文件不存在'),
        ),
        entryRows(which),
        consolidateControl(which),
        pruneControl(which),
      );
    }),
  );

  const projectEntryRow = (proj: ProjectInfo, entry: ProjectEntryInfo): React.ReactNode => {
    if (projConfirm && projConfirm.project === proj.name && projConfirm.file === entry.file) {
      return React.createElement('div', { key: proj.name + entry.file, style: { padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)', fontSize: 13 } },
        React.createElement('div', { style: { color: 'var(--dsw-alias-state-warn-primary)', marginBottom: 6 } },
          '确认删除 ' + entry.file + ' ？索引行会一并移除，文件移入 memory/.trash/（可恢复）'),
        React.createElement('div', { style: { display: 'flex', gap: 8 } },
          actionBtn('删除', () => mutate('projectDelete', { project: proj.name, file: entry.file }), { style: { background: 'var(--dsw-alias-state-error-primary)', borderColor: 'transparent', color: '#fff' } }),
          actionBtn('取消', () => setProjConfirm(null)),
        ),
      );
    }
    return React.createElement('div', { key: proj.name + entry.file, style: { padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 } },
      React.createElement('div', { style: { flex: 1, minWidth: 0 } },
        React.createElement('div', { style: { fontSize: 13, lineHeight: 1.5, wordBreak: 'break-all' } },
          '@' + entry.file + (entry.summary ? ' — ' + entry.summary : '')),
        React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 2 } },
          entry.exists ? entry.chars + ' 字符' : '文件缺失（索引仍在）'),
      ),
      React.createElement('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
        actionBtn('编辑', () => openProjectFile(proj, entry.file), { style: { padding: '3px 8px', fontSize: 12 } }),
        actionBtn('删除', () => setProjConfirm({ project: proj.name, file: entry.file }), { style: { padding: '3px 8px', fontSize: 12 } }),
      ),
    );
  };

  /**
   * Toggle the authoring guide. The text lives on the host (lib/project-guide.ts)
   * and is fetched once per page load, so the UI can never drift from what the
   * model is actually told.
   */
  const toggleGuide = async () => {
    if (guide.open) { setGuide({ ...guide, open: false }); return; }
    // Already fetched once this page load: just re-open, no second round trip.
    if (guide.text || guide.loading) { setGuide({ ...guide, open: true }); return; }
    setGuide({ open: true, text: null, loading: true });
    try {
      const res = await api('/projectGuide', undefined, 'GET');
      setGuide({ open: true, text: String(res.guide || ''), loading: false });
    } catch (e) {
      setGuide({ open: true, text: null, loading: false });
      setNotice('读取写法指南失败：' + String((e && (e as Error).message) || e));
    }
  };

  const projectGuidePanel = (): React.ReactNode => React.createElement('div', { style: { margin: '6px 0 10px' } },
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      actionBtn(guide.open ? '收起写法指南' : '怎么看/怎么写项目记忆（AGENTS.md 两区划分）', toggleGuide, { style: { padding: '3px 10px', fontSize: 12 } }),
      guide.text
        ? btn('复制', () => {
            try { void window.navigator.clipboard.writeText(guide.text || ''); } catch { /* clipboard blocked */ }
          }, { style: { padding: '3px 10px', fontSize: 12 } })
        : null,
    ),
    guide.open
      ? React.createElement('div', { style: { marginTop: 6, fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', background: 'var(--dsw-alias-bg-layer-1)', borderRadius: 6, padding: '8px 10px', maxHeight: 420, overflow: 'auto' } },
          guide.loading ? '读取中...' : (guide.text || '（读取失败，可刷新重试）'))
      : null,
  );

  const projectRows = (): React.ReactNode => {
    const nodes: React.ReactNode[] = [];
    if (projects.length === 0) {
      nodes.push(React.createElement('div', { key: 'empty', style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', padding: '6px 0' } },
        '（暂无项目记忆。在项目目录跑一次会话，模型用 project_memory 写入后会自动登记；也可以在下方手动登记路径）'));
    }
    projects.forEach((proj) => {
      const isOpen = projOpen === proj.name;
      const residentOver = proj.residentLimit > 0 && proj.residentChars > proj.residentLimit;
      const residentIsOpen = residentOpen[proj.name] === true;
      /**
       * Migration transforms a PROSE-only AGENTS.md into resident + index form.
       * Once any index entry exists the file is already in the target shape, and
       * there is nothing to migrate; with no AGENTS.md there is nothing to read.
       */
      const migratedAlready = proj.entries.length > 0;
      const noLlmRoute = !routeAvailable && state.llmRouteAvailable !== undefined;
      const canMigrate = proj.exists && !migratedAlready && (routeAvailable || state.llmRouteAvailable === undefined);
      const configuredRoute = state.llmRoute;
      const timeoutMs = Number(state.config && state.config.projectMigrateTimeoutMs);
      const timeoutLabel = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? (timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} 分钟` : `${Math.round(timeoutMs / 1000)} 秒`)
        : '20 分钟';
      const routeLabel = configuredRoute ? `${configuredRoute.provider}/${configuredRoute.model}` : '当前会话或默认模型';
      const migrationReason = migratedAlready
        ? '该项目的 AGENTS.md 已经是「常驻区 + 索引」形态，无需迁移'
        : !proj.exists
          ? '该项目还没有 AGENTS.md，没有可迁移的内容'
          : noLlmRoute
            ? '还没有可用的模型路由：请在 profile 的 agent-default-model 里配置默认 provider/model'
            : `用 ${routeLabel} 把纯散文的 AGENTS.md 拆成「常驻区 + @memory/ 索引」（超时 ${timeoutLabel}）`;
      const residentEditing = projResidentEdit && projResidentEdit.project === proj.name;
      const creating = projCreate && projCreate.project === proj.name;
      const editingHere = projEdit && projEdit.project === proj.name;

      nodes.push(React.createElement('div', { key: proj.name, style: { borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
        React.createElement('div', {
          onClick: () => setProjOpen(isOpen ? null : proj.name),
          style: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 0', cursor: 'pointer', userSelect: 'none' },
        },
          React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', transition: 'transform 0.2s', transform: isOpen ? 'rotate(90deg)' : 'none' } }, '\u25B8'),
          React.createElement('span', { style: { fontSize: 13, fontWeight: 600 } }, proj.name),
          React.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, proj.root || ''),
          React.createElement('span', { style: { fontSize: 12, color: residentOver ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-secondary)' } },
            proj.exists ? proj.entries.length + ' 个索引' : '无 AGENTS.md'),
        ),
        isOpen ? React.createElement('div', { style: { padding: '0 0 10px 20px' } },
          // ---- resident block (own disclosure: expanded it used to read as
          // part of the index list below, since both are plain text panels)
          React.createElement('div', { style: { margin: '2px 0 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: 6 } },
            React.createElement('div', {
              onClick: () => setResidentOpen({ ...residentOpen, [proj.name]: !residentIsOpen }),
              style: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', cursor: 'pointer', userSelect: 'none' },
            },
              React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', transition: 'transform 0.2s', transform: residentIsOpen ? 'rotate(90deg)' : 'none' } }, '\u25B8'),
              React.createElement('span', { style: { fontSize: 12, fontWeight: 600 } }, '常驻区（每次请求注入）'),
              React.createElement('span', { style: { flex: 1 } }),
              React.createElement('span', { style: { fontSize: 12, color: residentOver ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-secondary)' } },
                proj.residentChars + ' / ' + proj.residentLimit + ' 字符'),
            ),
            residentOver ? meter(Math.min(100, Math.round((proj.residentChars / proj.residentLimit) * 100))) : null,
            residentIsOpen
              ? (residentEditing
                  ? React.createElement('div', { style: { marginTop: 4 } },
                      React.createElement(TextArea, { value: projResidentEdit.content, onChange: (v) => setProjResidentEdit({ project: proj.name, content: v }), placeholder: '每行一条常驻规则；细节请写进 memory/ 主题文件', disabled: locked }),
                      React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
                        actionBtn('保存', () => mutate('projectResident', { project: proj.name, content: projResidentEdit.content })),
                        actionBtn('取消', () => setProjResidentEdit(null)),
                      ),
                    )
                  : React.createElement('div', { style: { marginTop: 4 } },
                      proj.resident.length === 0
                        ? React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', padding: '4px 0' } }, '（无，索引即全部内容）')
                        : React.createElement('div', { style: { fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', background: 'var(--dsw-alias-bg-layer-1)', borderRadius: 6, padding: '6px 8px', maxHeight: 180, overflow: 'auto' } }, proj.resident.join('\n')),
                      React.createElement('div', { style: { marginTop: 4 } },
                        actionBtn('编辑常驻区', () => { setProjResidentEdit({ project: proj.name, content: proj.resident.join('\n') }); setProjEdit(null); setProjCreate(null); }, { style: { padding: '3px 8px', fontSize: 12 } }),
                      ),
                    ))
              : null,
          ),
          // ---- index
          React.createElement('div', { style: { fontSize: 12, fontWeight: 600, margin: '2px 0 2px', display: 'flex', alignItems: 'center', gap: 8 } },
            React.createElement('span', null, '记忆索引（' + proj.entries.length + ' 项）'),
            React.createElement('span', { style: { flex: 1 } }),
            React.createElement('span', { style: { fontWeight: 400, color: 'var(--dsw-alias-label-secondary)' } },
              proj.indexChars + ' / ' + proj.indexLimit + ' 字符')),
          proj.entries.length === 0
            ? React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', padding: '4px 0' } }, '（无索引条目）')
            : proj.entries.map((entry) => projectEntryRow(proj, entry)),
          // ---- open file editor
          editingHere
            ? React.createElement('div', { style: { margin: '10px 0', padding: 8, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6 } },
                React.createElement('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 4 } }, '编辑 @' + projEdit.file),
                React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 } }, '索引描述'),
                React.createElement('input', {
                  value: projEdit.summary,
                  onChange: (e: React.ChangeEvent<HTMLInputElement>) => setProjEdit({ ...projEdit, summary: e.target.value }),
                  placeholder: '一句话描述（写进 AGENTS.md 的 @ 行）',
                  disabled: locked,
                  style: { width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '4px 6px', marginBottom: 6, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 4, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' },
                }),
                React.createElement(TextArea, { value: projEdit.content, onChange: (v) => setProjEdit({ ...projEdit, content: v }), placeholder: '记忆文件内容（Markdown）', disabled: locked }),
                React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
                  actionBtn('保存', () => mutate('projectWrite', { project: proj.name, file: projEdit.file, summary: projEdit.summary, content: projEdit.content })),
                  actionBtn('取消', () => setProjEdit(null)),
                ),
              )
            : null,
          // ---- orphans
          proj.orphans.length > 0
            ? React.createElement('div', { style: { margin: '10px 0 0' } },
                React.createElement('div', { style: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-state-warn-primary)', marginBottom: 2 } }, '未索引文件'),
                proj.orphans.map((file) => React.createElement('div', { key: proj.name + file, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, padding: '3px 0', gap: 8 } },
                  React.createElement('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, file),
                  React.createElement('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
                    actionBtn('查看', () => openProjectFile(proj, file), { style: { padding: '2px 8px', fontSize: 11 } }),
                    actionBtn('删除', () => setProjConfirm({ project: proj.name, file }), { style: { padding: '2px 8px', fontSize: 11 } }),
                  ),
                )),
              )
            : null,
          // ---- archive import picker (inline: no DOM file dialog, so the
          // bundle-contract test can render this state too)
          archivePick === proj.name
            ? React.createElement('div', { style: { margin: '10px 0', padding: 8, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6 } },
                React.createElement('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 4 } }, '导入记忆包到 ' + proj.name),
                React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginBottom: 6, lineHeight: 1.5 } },
                  '选择之前用「导出记忆包」得到的 zip。会写入 AGENTS.md 与 memory/ 下的文件：原 AGENTS.md 另存 .bak，同名主题文件移入 memory/.trash。'),
                React.createElement(ArchiveFileInput, {
                  disabled: locked,
                  onPick: (f: File) => { void importProject(proj.name, f); },
                }),
                React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
                  actionBtn('取消', () => setArchivePick(null)),
                ),
              )
            : null,
          // ---- create
          creating
            ? React.createElement('div', { style: { margin: '10px 0', padding: 8, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6 } },
                React.createElement('input', {
                  value: projCreate.file,
                  onChange: (e: React.ChangeEvent<HTMLInputElement>) => setProjCreate({ ...projCreate, file: e.target.value }),
                  placeholder: 'memory/新主题.md',
                  disabled: locked,
                  style: { width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '4px 6px', marginBottom: 6, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 4, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' },
                }),
                React.createElement('input', {
                  value: projCreate.summary,
                  onChange: (e: React.ChangeEvent<HTMLInputElement>) => setProjCreate({ ...projCreate, summary: e.target.value }),
                  placeholder: '一句话描述',
                  disabled: locked,
                  style: { width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '4px 6px', marginBottom: 6, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 4, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' },
                }),
                React.createElement(TextArea, { value: projCreate.content, onChange: (v) => setProjCreate({ ...projCreate, content: v }), placeholder: '文件内容（Markdown）', disabled: locked }),
                React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
                  actionBtn('创建', () => mutate('projectCreate', { project: proj.name, file: projCreate.file, summary: projCreate.summary, content: projCreate.content })),
                  actionBtn('取消', () => setProjCreate(null)),
                ),
              )
            : React.createElement('div', { style: { marginTop: 10 } },
                React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                  actionBtn('+ 新建记忆文件', () => { setProjCreate({ project: proj.name, file: 'memory/', summary: '', content: '' }); setProjEdit(null); setProjResidentEdit(null); }, { style: { padding: '3px 10px', fontSize: 12 } }),
                  // Migration is a one-shot transformation of a prose document;
                  // once index entries exist it is meaningless and unsafe.
                  actionBtn(activeMigration && migration && migration.project === proj.name ? '迁移处理中…' : '迁移旧 AGENTS.md',
                    () => mutate('projectMigrate', { project: proj.name, apply: true }), {
                      disabled: !canMigrate,
                      style: {
                        padding: '3px 10px',
                        fontSize: 12,
                        opacity: canMigrate ? 1 : 0.4,
                      },
                      title: migrationReason,
                    }),
                  // Archive export/import: the zip carries AGENTS.md + memory/**
                  // so the same project's memory can be restored on another
                  // machine without committing anything.
                  actionBtn('导出记忆包', () => exportProject(proj), {
                    disabled: !proj.exists,
                    style: { padding: '3px 10px', fontSize: 12, opacity: proj.exists ? 1 : 0.4 },
                    title: proj.exists
                      ? '把该项目当前 AGENTS.md + memory/ 全部内容打包成 zip 下载'
                      : '该项目还没有 AGENTS.md，没有可导出的记忆',
                  }),
                  actionBtn('导入记忆包', () => { setArchivePick(archivePick === proj.name ? null : proj.name); setProjCreate(null); setProjEdit(null); setProjResidentEdit(null); }, {
                    style: { padding: '3px 10px', fontSize: 12 },
                    title: '选择之前导出的 zip，用它的内容覆盖本项目的 AGENTS.md 与 memory/ 同名文件（原文件会备份 / 进 .trash）',
                  }),
                ),
                React.createElement('div', { style: { fontSize: 11, color: noLlmRoute ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-secondary)', marginTop: 4, lineHeight: 1.5 } },
                  migratedAlready
                    ? '已迁移，按钮已停用。继续精简常驻区请用上方「编辑常驻区」。'
                    : noLlmRoute
                      ? '没有默认模型路由：请在 profile 的 agent-default-model 里配置 provider/model 后重启 web。'
                      : canMigrate
                        ? `使用 ${routeLabel} 拆分「常驻区 + 索引」，原文另存 .bak；规划超时 ${timeoutLabel}，可在插件配置里调整。`
                        : '该项目还没有 AGENTS.md。'),
                React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 2, lineHeight: 1.5 } },
                  '导出/导入用于换机器迁移同一个项目的记忆：zip 内是 AGENTS.md + memory/ 主题文件。导入会覆盖同名文件，旧的 AGENTS.md 另存 .bak、旧主题文件移入 memory/.trash。'),
              ),
        ) : null,
      ));
    });
    // ---- manual registration + bulk scan
    const pathInput = (value: string, onChange: (v: string) => void, placeholder: string): React.ReactElement =>
      React.createElement('input', {
        value,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value),
        placeholder,
        disabled: locked,
        style: { flex: 1, fontSize: 12, padding: '4px 6px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 4, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' },
      });
    nodes.push(React.createElement('div', { key: 'register', style: { marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-l1)' } },
      React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
        pathInput(newProjectPath, setNewProjectPath, '仓库路径（子目录会自动归到仓库根）'),
        actionBtn('登记项目', () => mutate('projectRegister', { root: newProjectPath }), { style: { padding: '3px 10px', fontSize: 12 } }),
      ),
      React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 } },
        pathInput(scanPath, setScanPath, '父目录（扫描其下所有 git 仓库，最多 4 层）'),
        actionBtn('扫描目录', () => mutate('projectScan', { root: scanPath }), { style: { padding: '3px 10px', fontSize: 12 } }),
      ),
      React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 6, lineHeight: 1.5 } },
        '只登记路径，不改动仓库文件。会话里写过记忆的已自动登记。'),
    ));
    return nodes;
  };

  const projectsBody = (): React.ReactElement => React.createElement('div', null,
    React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', padding: '6px 0' } },
      '项目根目录的 AGENTS.md = 常驻区 + @memory/ 索引；记忆正文在 memory/ 下按主题分文件，按需读取。点索引行的「编辑」编辑该文件全文。'),
    projectGuidePanel(),
    React.createElement('div', { style: { marginTop: 4 } }, projectRows()),
  );

  const modelStatusLine = (): React.ReactNode => {
    if (!cfgForm || !cfgForm.embeddingModel || !String(cfgForm.embeddingModel).trim()) return null;
    if (modelStatus && modelStatus.checking) {
      return React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: '6px 0' } }, '检查缓存...');
    }
    if (modelStatus && modelStatus.cached) {
      return React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-success-primary)', margin: '6px 0' } }, '已缓存，可直接使用');
    }
    return React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)', margin: '6px 0' } },
      '未缓存 - 保存并重启后，首次 memory_search 会从 ' + (String(cfgForm.embeddingRemoteHost ?? '') || 'https://huggingface.co') + ' 自动下载');
  };

  const indexesBody = (): React.ReactElement => React.createElement('div', null,
    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', fontSize: 13, borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
      React.createElement('span', null, 'FTS5 全文索引'),
      React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, idx.fts && idx.fts.exists ? fmtBytes(idx.fts.size) : '未生成')),
    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', fontSize: 13, borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
      React.createElement('span', null, '向量索引 (embedding)'),
      React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, idx.vector && idx.vector.exists ? fmtBytes(idx.vector.size) : '未启用')),
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0 2px' } },
      React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '索引可随时重建，不影响记忆本体；向量搜索相关配置见下方「插件配置」卡'),
      actionBtn('重建向量索引', () => mutate('rebuildVector', {}), { style: { background: 'var(--dsw-alias-bg-layer-2)' } }),
    ),
  );

  const backupsBody = (): React.ReactElement => {
    // Two columns: actions on the left, the snapshot list on the right. Each
    // row = timestamp · file count · its own 恢复 button, so the restore source
    // is always the row you clicked (there is no separate "restore latest"
    // mode — `latest` is simply the first row).
    const restoreRow = (b: BackupSnapshot): React.ReactElement => {
      const confirming = confirmRestore === b.name;
      return React.createElement('div', {
        key: b.name,
        style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '7px 0', fontSize: 13, borderBottom: '1px solid var(--dsw-alias-border-l1)' },
      },
        React.createElement('span', { style: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' } },
          React.createElement('span', { style: { fontVariantNumeric: 'tabular-nums' } }, fmtStamp(b.mtime)),
          b.kind === 'latest'
            ? React.createElement('span', { style: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 12 } }, '最新')
            : null,
          React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, whiteSpace: 'nowrap' } }, b.files + ' 文件'),
        ),
        confirming
          ? React.createElement(React.Fragment, null,
              actionBtn('确认覆盖', () => mutate('restoreLatest', { snapshot: b.name }), { style: { background: 'var(--dsw-alias-state-error-primary)', borderColor: 'transparent', color: '#fff', padding: '3px 10px', fontSize: 12 } }),
              actionBtn('取消', () => setConfirmRestore(null), { style: { padding: '3px 10px', fontSize: 12 } }),
            )
          : actionBtn('恢复', () => setConfirmRestore(b.name), {
              disabled: !b.restorable,
              style: { background: 'var(--dsw-alias-bg-layer-2)', padding: '3px 10px', fontSize: 12, whiteSpace: 'nowrap' },
              title: '用该快照覆盖当前记忆',
            }),
      );
    };
    return React.createElement('div', {
      style: { display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start', paddingTop: 6 },
    },
      // left column: where the backups live + the manual action
      React.createElement('div', { style: { flex: '1 1 200px', minWidth: 180 } },
        React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6, wordBreak: 'break-all' } },
          '备份目录: ' + (state.backupDir || '')),
        React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6, marginTop: 4 } },
          '与 Pi 完全隔离；latest 每次覆盖写一份，历史快照保留最近 ' + (state.backupKeep ?? 10)
          + ' 份（「插件配置 → 备份」可改，0=只留 latest）'),
        React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '10px 0 0' } },
          actionBtn('立即备份', () => mutate('backup', {}), { style: { background: 'var(--dsw-alias-bg-layer-2)' } }),
        ),
        React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6, marginTop: 8 } },
          '「恢复」会用该快照覆盖当前记忆（全局 4 文件 + 已登记项目），需二次确认。Pi 记忆丢失时默认自动切回本地并从 latest 恢复。'),
      ),
      // right column: the snapshot list
      React.createElement('div', { style: { flex: '2 1 320px', minWidth: 240 } },
        backups.length === 0
          ? React.createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', padding: '8px 0' } }, '（尚无备份，可手动备份或等待自动备份）')
          : backups.map(restoreRow),
      ),
    );
  };

  const configBody = (): React.ReactElement => {
    if (!cfgForm || !Array.isArray(state.schema)) {
      return React.createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, '读取配置中...');
    }
    const groups: React.ReactElement[] = [];
    const order: string[] = [];
    for (const f of state.schema) {
      if (!order.includes(f.group)) order.push(f.group);
    }
    for (const g of order) {
      const gOpen = cfgGroupsOpen[g] !== false; // default expanded
      groups.push(React.createElement('div', { key: g },
        React.createElement('div', {
          onClick: () => setCfgGroupsOpen(Object.assign({}, cfgGroupsOpen, { [g]: !gOpen })),
          style: { display: 'flex', alignItems: 'center', gap: 8, margin: '14px 0 8px', cursor: 'pointer', userSelect: 'none' },
        },
          React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', transition: 'transform 0.2s', transform: gOpen ? 'rotate(90deg)' : 'none' } }, '\u25B8'),
          React.createElement('span', {
            style: {
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--dsw-alias-label-secondary)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            },
          }, g),
          React.createElement('span', { style: { flex: 1, borderBottom: '1px solid var(--dsw-alias-border-l1)' } }),
        ),
        gOpen ? state.schema.filter((f) => f.group === g).map((f) => {
          const key = f.key;
          const val = cfgForm[key];
          const setVal = (v: unknown) => setCfgForm(Object.assign({}, cfgForm, { [key]: v }));
          let control: React.ReactNode = null;
          if (f.type === 'bool') {
            control = React.createElement('input', {
              type: 'checkbox',
              checked: !!val,
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => setVal(e.target.checked),
              disabled: locked,
            });
          } else if (f.type === 'number') {
            control = numberInput(val, setVal, '', locked);
          } else if (f.type === 'select') {
            control = React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
              (f.options || []).map((opt) => {
                const active = String(val) === opt;
                return actionBtn(opt, () => setVal(opt), {
                  style: {
                    padding: '3px 10px',
                    fontSize: 12,
                    // Active state = "pressed" inversion: fill with label-primary
                    // (the shell's monochrome accent), text in the opposite
                    // surface color. The brand token equals label-primary here
                    // anyway, and #fff text on it vanished in dark mode.
                    background: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-bg-layer-2)',
                    borderColor: active ? 'transparent' : 'var(--dsw-alias-border-l2)',
                    color: active ? 'var(--dsw-alias-bg-layer-1)' : 'var(--dsw-alias-label-primary)',
                    fontWeight: active ? 600 : 400,
                  },
                });
              }),
            );
          } else {
            control = key === 'embeddingModel'
              ? React.createElement('div', null,
                  input(val, setVal, '模型名', locked),
                  modelStatusLine(),
                  React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: '8px 0 4px' } }, '已下载模型（点击选用）'),
                  React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                    (m.models || []).map((mo) => {
                      const active = String(val) === mo.name;
                      return actionBtn(mo.name, () => setVal(mo.name), {
                        style: {
                          padding: '3px 10px',
                          fontSize: 12,
                          // Same pressed-inversion treatment as the select buttons.
                          background: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-bg-layer-2)',
                          borderColor: active ? 'transparent' : 'var(--dsw-alias-border-l2)',
                          color: active ? 'var(--dsw-alias-bg-layer-1)' : 'var(--dsw-alias-label-primary)',
                          fontWeight: active ? 600 : 400,
                        },
                      });
                    }),
                    m.models && m.models.length === 0
                      ? React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '缓存中暂无模型')
                      : null,
                  ),
                )
              : input(val, setVal, '', locked);
          }
          return React.createElement('div', { key, style: { padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600 } },
              f.type === 'bool' ? control : React.createElement('span', { style: { minWidth: 0, flex: 1 } }, f.label),
              f.type === 'bool'
                ? React.createElement('span', { style: { flex: 1 } }, f.label)
                : null,
            ),
            f.type !== 'bool' ? React.createElement('div', { style: { marginTop: 6 } }, control) : null,
            f.help ? React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 4 } }, f.help) : null,
          );
        }) : null,
      ));
    }
    return React.createElement('div', null,
      React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', padding: '8px 0' } },
        '所有配置写回当前 profile 的 cordis.patch.yml（persona-memory 段），保存后约 2 秒热生效，无需重启 web'),
      groups,
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 } },
        // Default button look (no brand override): --dsw-alias-brand-primary is
        // undefined in the web shell, which rendered this CTA as a white blank.
        actionBtn('保存全部配置', saveConfig, { style: { fontWeight: 600 } }),
        React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)' } }, '保存后约 2 秒热生效，无需重启'),
      ),
    );
  };

  const standingSummary = standing.length + ' 条' + ((state.standing || {}).chars ? ' · ' + (state.standing || {}).chars + ' 字符' : '');
  const memStore = st.memory || {};
  const usrStore = st.user || {};
  const filesSummary = (memStore.exists ? 'MEMORY ' + memStore.entries + ' 条' : 'MEMORY 缺失') + ' · '
    + (usrStore.exists ? 'USER ' + usrStore.entries + ' 条' : 'USER 缺失');
  const idxSummary = (idx.fts && idx.fts.exists ? 'FTS5 ' + fmtBytes(idx.fts.size) : 'FTS5 未生成') + ' · '
    + (idx.vector && idx.vector.exists ? '向量 ' + fmtBytes(idx.vector.size) : '向量未启用');
  const projectsSummary = projects.length + ' 个';
  const historyCount = backups.filter((b) => b.kind === 'history').length;
  const backupsSummary = backups.length > 0
    ? 'latest + ' + historyCount + ' 历史 · ' + backups[0].files + ' 文件'
    : '无';
  const configSummary = (state.schema || []).length + ' 项';

  /** The progress strip is the answer to "处理中是真的在处理吗？". It names
   *  the action, the host's real stage, and a live elapsed timer. */
  const progressLine = (): React.ReactNode => {
    if (!locked && !lastOutcome) return null;
    const label = activeTask ? activeTask.label : '迁移旧 AGENTS.md';
    const shown = locked ? migration : lastOutcome;
    const stage = stageLabel(shown ? shown.stage : undefined);
    const parts: string[] = [];
    if (locked) {
      parts.push(label + ' 处理中');
      if (stage && activeMigration) parts.push(stage);
      if (shown && shown.detail) parts.push(shown.detail);
      if (activeTask) parts.push(fmtElapsed(elapsed));
      if (activeMigration && migration && migration.startedAt && !activeTask) parts.push(fmtElapsed(Date.now() - migration.startedAt));
    } else if (lastOutcome) {
      parts.push('上次迁移：' + (stage || '已结束'));
      if (lastOutcome.reason) parts.push(lastOutcome.reason);
      if (lastOutcome.detail) parts.push(lastOutcome.detail);
      if (lastOutcome.elapsedMs) parts.push('耗时 ' + fmtElapsed(lastOutcome.elapsedMs));
    }
    return React.createElement('div', {
      role: 'status',
      style: {
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        fontSize: 12, lineHeight: 1.5,
        color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 6, padding: '6px 10px', marginBottom: 8,
        wordBreak: 'break-word',
      },
    },
      React.createElement('span', {
        style: {
          width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
          background: locked ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-border-l2)',
          display: 'inline-block',
        },
      }),
      React.createElement('span', { style: { flex: 1, minWidth: 0 } }, parts.join(' · ')),
      locked
        ? React.createElement('span', { style: { fontSize: 11, whiteSpace: 'nowrap' } }, '处理期间按钮与输入框已锁定')
        : btn('知道了', () => setLastOutcome(null), { style: { padding: '2px 8px', fontSize: 11 } }),
    );
  };

  return React.createElement('div', { style: { maxWidth: 720 } },
    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
      React.createElement('div', { style: { fontWeight: 600, fontSize: 15 } }, '记忆管理'),
      React.createElement('div', { style: { display: 'flex', gap: 8 } },
        btn(locked ? '处理中' : '刷新', load, {
          disabled: locked,
          title: locked ? '请求处理中，按钮已禁用' : '重新读取全部记忆状态',
          style: { opacity: locked ? 0.6 : 1 },
        }),
      ),
    ),
    progressLine(),
    notice ? React.createElement('div', {
      style: {
        fontSize: 13,
        color: /失败|错误|未迁移|未完成/.test(notice) ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)',
        margin: '0 0 8px',
        // Rejection reasons can be long (they may quote a plan); keep the page
        // readable instead of letting one message scroll the cards off screen.
        maxHeight: 160,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        lineHeight: 1.5,
      },
    }, notice.length > 600 ? notice.slice(0, 600) + ' …（完整原因见浏览器控制台）' : notice) : null,
    React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 12 } },
      '目录: ' + (state.dir || '(未找到)') + '  [' + (state.which || '') + ']'),

    card('standing', '常驻指令', standingSummary,
      React.createElement('div', null,
        React.createElement('div', { style: { display: 'flex', gap: 8, margin: '10px 0' } },
          React.createElement('div', { style: { flex: 1 } }, input(newStanding, (v) => setNewStanding(v), '新增常驻指令...', locked)),
          actionBtn('添加', () => mutate('standingAdd', { text: newStanding })),
        ),
        standingRows(),
      ),
    ),

    card('files', '记忆文件', filesSummary, filesBody()),

    card('projects', '项目记忆', projectsSummary, projectsBody()),

    card('indexes', '检索索引', idxSummary, indexesBody()),

    card('backups', '本地备份', backupsSummary, backupsBody()),

    card('config', '插件配置', configSummary, configBody()),
  );
}

// ------------------------------------------------------------ mount

/** Services required by this page (settings slot host). */
export const inject = ['slots'];

/** Loose slots-service contract (dsh-client-ui-slots' generics are heavy). */
interface SlotsLike {
  inject(slot: string, factory: () => unknown): unknown;
  register(options: Record<string, unknown>, component: React.ComponentType): unknown;
}

/**
 * Register the 记忆管理 page into the Web Settings section.
 * @param ctx - client root context (slots service).
 */
export function apply(ctx: { slots: SlotsLike }): void {
  // Direct injection like the shipped ui-* plugins: slots.inject returns
  // the disposer the fiber owns; no extra ctx.effect wrapper needed.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'persona-memory',
    order: 25,
    label: '记忆管理',
  }, MemAdminPage));
}
