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
  lastReferenced: string;
  project: string | null;
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
  backups: Array<{ name: string; files: number }>;
  stores: Record<string, { exists: boolean; entries: number; chars: number; usagePct: number }>;
  standing: { exists: boolean; instructions: string[]; chars: number };
  indexes: { fts: { exists: boolean; size: number }; vector: { exists: boolean; size: number } };
  models: { dir: string; models: Array<{ name: string }> };
  projects: ProjectInfo[];
  entries: Record<string, EntryItem[]>;
  ts: number;
}

interface EditingState {
  which: string;
  index: number;
  text: string;
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

// ----------------------------------------------------------- helpers

function fmtBytes(n: number | undefined | null): string {
  if (!n && n !== 0) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function btn(
  label: React.ReactNode,
  onClick: () => void,
  opts?: { disabled?: boolean; style?: React.CSSProperties; title?: string },
): React.ReactElement {
  return React.createElement('button', {
    onClick,
    disabled: opts && opts.disabled,
    title: opts && opts.title,
    style: Object.assign({
      padding: '5px 12px',
      borderRadius: 6,
      fontSize: 13,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      cursor: opts && opts.disabled ? 'default' : 'pointer',
    }, opts && opts.style),
  }, label);
}

function input(value: unknown, onChange: (v: string) => void, placeholder?: string): React.ReactElement {
  return React.createElement('input', {
    value: value === undefined || value === null ? '' : (value as string | number),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value),
    placeholder,
    style: {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 10px',
      borderRadius: 6,
      fontSize: 13,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
    },
  });
}

function numberInput(value: unknown, onChange: (v: string) => void, placeholder?: string): React.ReactElement {
  return React.createElement('input', {
    type: 'number',
    value: value === undefined || value === null ? '' : (value as string | number),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value),
    placeholder,
    style: {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 10px',
      borderRadius: 6,
      fontSize: 13,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
    },
  });
}

// 编辑用多行输入框：按内容高度自动展开，完整显示全部文字。
// 最小 3 行，最大 300px 内滚动；内容变化时重新测量。
// 必须是独立组件：hooks（useRef/useLayoutEffect）归属组件自身，
// 写成普通函数会在条件渲染时崩 React error #310。
function TextArea(props: { value: string; onChange: (v: string) => void; placeholder?: string }): React.ReactElement {
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
    },
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
  const [busy, setBusy] = React.useState(false);
  const [editing, setEditing] = React.useState<EditingState | null>(null);
  const [confirmDel, setConfirmDel] = React.useState<EditingState | null>(null);
  const [initialUi] = React.useState(loadUiState);
  const [projOpen, setProjOpen] = React.useState<string | null>(initialUi.projOpen);
  /** Resident block is collapsed by default: it is a reference panel, and
   *  expanded it visually ran into the index list below it. */
  const [residentOpen, setResidentOpen] = React.useState<Record<string, boolean>>(initialUi.residentOpen);
  const [projEdit, setProjEdit] = React.useState<ProjectFileEditState | null>(null);
  const [projResidentEdit, setProjResidentEdit] = React.useState<ProjectResidentEditState | null>(null);
  const [projCreate, setProjCreate] = React.useState<ProjectCreateState | null>(null);
  const [projConfirm, setProjConfirm] = React.useState<{ project: string; file: string } | null>(null);
  const [newProjectPath, setNewProjectPath] = React.useState('');
  /** parent directory to scan for repositories */
  const [scanPath, setScanPath] = React.useState('');
  const [standingEdit, setStandingEdit] = React.useState<StandingEditState | null>(null);
  const [newStanding, setNewStanding] = React.useState('');
  const [open, setOpen] = React.useState<Record<string, boolean>>(initialUi.open);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [cfgForm, setCfgForm] = React.useState<Record<string, unknown> | null>(null);
  /** config-group disclosure inside 插件配置; missing key = expanded (schema-driven groups are mostly read top-down) */
  const [cfgGroupsOpen, setCfgGroupsOpen] = React.useState<Record<string, boolean>>(initialUi.configGroups);
  const [modelStatus, setModelStatus] = React.useState<ModelStatusState | null>(null);
  const [confirmRestore, setConfirmRestore] = React.useState(false);

  const load = React.useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await api('/status', undefined, 'GET');
      setState(s as StatusPayload);
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
      setError(String((e && (e as Error).message) || e));
    } finally {
      setBusy(false);
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

  const mutate = async (action: string, payload?: unknown) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api('/' + action, payload || {});
      if (res && res.error) setNotice('操作失败: ' + res.error);
      // Mutations that report success:false carry a human-readable `reason`
      // (e.g. the migration planner's output failing a gate) — show it as the
      // outcome rather than a generic "完成".
      else if (res && res.migrated === false && res.reason) setNotice('未迁移：' + res.reason);
      else if (res && res.ok === false && res.reason) setNotice('未完成：' + res.reason);
      else setNotice((res && res.message) || '完成');
      setEditing(null);
      setConfirmDel(null);
      setProjEdit(null);
      setProjResidentEdit(null);
      setProjCreate(null);
      setProjConfirm(null);
      setNewProjectPath('');
      setScanPath('');
      setStandingEdit(null);
      setNewStanding('');
      setConfirmRestore(false);
      await load();
    } catch (e) {
      setError(String((e && (e as Error).message) || e));
    } finally {
      setBusy(false);
    }
  };

  const saveConfig = async () => {
    if (!cfgForm) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api('/configSave', cfgForm);
      if (res && res.error) setNotice('保存失败: ' + res.error);
      else setNotice((res && res.message) || '配置已保存');
      await load();
    } catch (e) {
      // A rejected action (e.g. the migration planner's output failing a gate)
      // is a normal outcome, not a page failure: surface it in the notice area
      // so the cards stay visible and the user can read the reason and retry.
      // Only a failed initial LOAD blanks the page (see `load`).
      setNotice('操作失败: ' + String((e && (e as Error).message) || e));
    } finally {
      setBusy(false);
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
  const whichName: Record<string, string> = { memory: 'MEMORY.md', user: 'USER.md', failure: 'failures.md' };

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

  const entryRows = (which: string): React.ReactNode => {
    const list = (state.entries || {})[which] || [];
    if (list.length === 0) {
      return React.createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', padding: '6px 0' } }, '（无条目）');
    }
    return list.map((entry, i) => {
      const isEditing = editing && editing.which === which && editing.index === i;
      const isConfirm = confirmDel && confirmDel.which === which && confirmDel.index === i;
      if (isEditing) {
        return React.createElement('div', { key: which + i, style: { padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
          React.createElement(TextArea, { value: editing.text, onChange: (v) => setEditing({ which, index: i, text: v }), placeholder: '条目内容' }),
          React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
            btn('保存', () => mutate('update', { which, index: i, text: editing.text })),
            btn('取消', () => setEditing(null)),
          ),
        );
      }
      if (isConfirm) {
        return React.createElement('div', { key: which + i, style: { padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)', fontSize: 13 } },
          React.createElement('div', { style: { color: 'var(--dsw-alias-state-warn-primary)', marginBottom: 6 } }, '确认删除这条? ' + String(entry.text || '').slice(0, 60)),
          React.createElement('div', { style: { display: 'flex', gap: 8 } },
            btn('删除', () => mutate('delete', { which, index: i }), { style: { background: 'var(--dsw-alias-state-error-primary)', borderColor: 'transparent', color: '#fff' } }),
            btn('取消', () => setConfirmDel(null)),
          ),
        );
      }
      return React.createElement('div', { key: which + i, style: { padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
        React.createElement('span', {
          style: {
            fontSize: 13,
            lineHeight: 1.5,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
          },
        }, String(entry.text || '')),
        React.createElement('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
          btn('编辑', () => setEditing({ which, index: i, text: String(entry.text || '') }), { style: { padding: '3px 8px', fontSize: 12 } }),
          btn('删除', () => setConfirmDel({ which, index: i, text: String(entry.text || '') }), { style: { padding: '3px 8px', fontSize: 12 } }),
        ),
      );
    });
  };

  const standingRows = (): React.ReactNode => {
    if (standing.length === 0) {
      return React.createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', padding: '6px 0' } }, '（无常驻指令，可添加）');
    }
    return standing.map((text, i) => {
      const isEditing = standingEdit && standingEdit.index === i;
      if (isEditing) {
        return React.createElement('div', { key: 'st' + i, style: { padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
          React.createElement(TextArea, { value: standingEdit.text, onChange: (v) => setStandingEdit({ index: i, text: v }), placeholder: '指令内容' }),
          React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
            btn('保存', () => mutate('standingUpdate', { index: i, text: standingEdit.text })),
            btn('取消', () => setStandingEdit(null)),
          ),
        );
      }
      return React.createElement('div', { key: 'st' + i, style: { padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
        React.createElement('span', { style: { fontSize: 13, lineHeight: 1.5, flex: 1 } }, (i + 1) + '. ' + String(text || '')),
        React.createElement('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
          btn('编辑', () => setStandingEdit({ index: i, text: String(text || '') }), { style: { padding: '3px 8px', fontSize: 12 } }),
          btn('删除', () => mutate('standingRemove', { index: i }), { style: { padding: '3px 8px', fontSize: 12 } }),
        ),
      );
    });
  };

  const filesBody = (): React.ReactElement => React.createElement('div', null,
    ['memory', 'user', 'failure'].map((w) => {
      const s = st[w];
      return React.createElement('div', { key: w, style: { margin: '10px 0' } },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 600, marginBottom: 2 } },
          React.createElement('span', null, whichName[w]),
          React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontWeight: 400 } },
            (s && s.exists ? s.entries + ' 条 / ' + s.chars + ' 字符' : '不存在')),
        ),
        s && s.exists ? meter(s.usagePct) : null,
        React.createElement('div', { style: { marginTop: 6 } }, entryRows(w)),
      );
    }),
  );

  /** Row for one `@memory/...` index entry. */
  const projectEntryRow = (proj: ProjectInfo, entry: ProjectEntryInfo): React.ReactElement => {
    const isConfirm = projConfirm && projConfirm.project === proj.name && projConfirm.file === entry.file;
    if (isConfirm) {
      return React.createElement('div', { key: proj.name + entry.file, style: { padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)', fontSize: 13 } },
        React.createElement('div', { style: { color: 'var(--dsw-alias-state-warn-primary)', marginBottom: 6 } },
          '确认删除 ' + entry.file + ' ？索引行会一并移除，文件移入 memory/.trash/（可恢复）'),
        React.createElement('div', { style: { display: 'flex', gap: 8 } },
          btn('删除', () => mutate('projectDelete', { project: proj.name, file: entry.file }), { style: { background: 'var(--dsw-alias-state-error-primary)', borderColor: 'transparent', color: '#fff' } }),
          btn('取消', () => setProjConfirm(null)),
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
        btn('编辑', () => openProjectFile(proj, entry.file), { style: { padding: '3px 8px', fontSize: 12 } }),
        btn('删除', () => setProjConfirm({ project: proj.name, file: entry.file }), { style: { padding: '3px 8px', fontSize: 12 } }),
      ),
    );
  };

  /** Load one topic file into the editor. */
  const openProjectFile = async (proj: ProjectInfo, file: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api('/projectRead', { project: proj.name, file });
      setProjEdit({ project: proj.name, file, summary: String(res.summary || ''), content: String(res.content || '') });
      setProjResidentEdit(null);
      setProjCreate(null);
    } catch (e) {
      setError(String((e && (e as Error).message) || e));
    } finally {
      setBusy(false);
    }
  };

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
      const canMigrate = proj.exists && !migratedAlready;
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
                      React.createElement(TextArea, { value: projResidentEdit.content, onChange: (v) => setProjResidentEdit({ project: proj.name, content: v }), placeholder: '每行一条常驻规则；细节请写进 memory/ 主题文件' }),
                      React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
                        btn('保存', () => mutate('projectResident', { project: proj.name, content: projResidentEdit.content })),
                        btn('取消', () => setProjResidentEdit(null)),
                      ),
                    )
                  : React.createElement('div', { style: { marginTop: 4 } },
                      proj.resident.length === 0
                        ? React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', padding: '4px 0' } }, '（无，索引即全部内容）')
                        : React.createElement('div', { style: { fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', background: 'var(--dsw-alias-bg-layer-1)', borderRadius: 6, padding: '6px 8px', maxHeight: 180, overflow: 'auto' } }, proj.resident.join('\n')),
                      React.createElement('div', { style: { marginTop: 4 } },
                        btn('编辑常驻区', () => { setProjResidentEdit({ project: proj.name, content: proj.resident.join('\n') }); setProjEdit(null); setProjCreate(null); }, { style: { padding: '3px 8px', fontSize: 12 } }),
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
                  style: { width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '4px 6px', marginBottom: 6, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 4, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' },
                }),
                React.createElement(TextArea, { value: projEdit.content, onChange: (v) => setProjEdit({ ...projEdit, content: v }), placeholder: '记忆文件内容（Markdown）' }),
                React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
                  btn('保存', () => mutate('projectWrite', { project: proj.name, file: projEdit.file, summary: projEdit.summary, content: projEdit.content })),
                  btn('取消', () => setProjEdit(null)),
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
                    btn('查看', () => openProjectFile(proj, file), { style: { padding: '2px 8px', fontSize: 11 } }),
                    btn('删除', () => setProjConfirm({ project: proj.name, file }), { style: { padding: '2px 8px', fontSize: 11 } }),
                  ),
                )),
              )
            : null,
          // ---- create
          creating
            ? React.createElement('div', { style: { margin: '10px 0', padding: 8, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6 } },
                React.createElement('input', {
                  value: projCreate.file,
                  onChange: (e: React.ChangeEvent<HTMLInputElement>) => setProjCreate({ ...projCreate, file: e.target.value }),
                  placeholder: 'memory/新主题.md',
                  style: { width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '4px 6px', marginBottom: 6, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 4, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' },
                }),
                React.createElement('input', {
                  value: projCreate.summary,
                  onChange: (e: React.ChangeEvent<HTMLInputElement>) => setProjCreate({ ...projCreate, summary: e.target.value }),
                  placeholder: '一句话描述',
                  style: { width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '4px 6px', marginBottom: 6, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 4, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' },
                }),
                React.createElement(TextArea, { value: projCreate.content, onChange: (v) => setProjCreate({ ...projCreate, content: v }), placeholder: '文件内容（Markdown）' }),
                React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
                  btn('创建', () => mutate('projectCreate', { project: proj.name, file: projCreate.file, summary: projCreate.summary, content: projCreate.content })),
                  btn('取消', () => setProjCreate(null)),
                ),
              )
            : React.createElement('div', { style: { marginTop: 10 } },
                React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                  btn('+ 新建记忆文件', () => { setProjCreate({ project: proj.name, file: 'memory/', summary: '', content: '' }); setProjEdit(null); setProjResidentEdit(null); }, { style: { padding: '3px 10px', fontSize: 12 } }),
                  // Migration is a one-shot transformation of a prose document;
                  // once index entries exist it is meaningless and unsafe.
                  btn('迁移旧 AGENTS.md', () => mutate('projectMigrate', { project: proj.name, apply: true }), {
                    disabled: !canMigrate,
                    style: {
                      padding: '3px 10px',
                      fontSize: 12,
                      opacity: canMigrate ? 1 : 0.4,
                      cursor: canMigrate ? 'pointer' : 'not-allowed',
                    },
                    title: canMigrate
                      ? '把纯散文的 AGENTS.md 拆成「常驻区 + @memory/ 索引」'
                      : migratedAlready
                        ? '该项目的 AGENTS.md 已经是「常驻区 + 索引」形态，无需迁移'
                        : '该项目还没有 AGENTS.md，没有可迁移的内容',
                  }),
                ),
                React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 4, lineHeight: 1.5 } },
                  migratedAlready
                    ? '已迁移，按钮已停用。继续精简常驻区请用上方「编辑常驻区」。'
                    : canMigrate
                      ? '把散文 AGENTS.md 拆成「常驻区 + 索引」，原文另存 .bak。'
                      : '该项目还没有 AGENTS.md。'),
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
        style: { flex: 1, fontSize: 12, padding: '4px 6px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 4, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' },
      });
    nodes.push(React.createElement('div', { key: 'register', style: { marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-l1)' } },
      React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
        pathInput(newProjectPath, setNewProjectPath, '仓库路径（子目录会自动归到仓库根）'),
        btn('登记项目', () => mutate('projectRegister', { root: newProjectPath }), { style: { padding: '3px 10px', fontSize: 12 } }),
      ),
      React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 } },
        pathInput(scanPath, setScanPath, '父目录（扫描其下所有 git 仓库，最多 4 层）'),
        btn('扫描目录', () => mutate('projectScan', { root: scanPath }), { style: { padding: '3px 10px', fontSize: 12 } }),
      ),
      React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 6, lineHeight: 1.5 } },
        '只登记路径，不改动仓库文件。会话里写过记忆的已自动登记。'),
    ));
    return nodes;
  };

  const projectsBody = (): React.ReactElement => React.createElement('div', null,
    React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', padding: '6px 0' } },
      '项目根目录的 AGENTS.md = 常驻区 + @memory/ 索引；记忆正文在 memory/ 下按主题分文件，按需读取。点索引行的「编辑」编辑该文件全文。'),
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
      btn('重建向量索引', () => mutate('rebuildVector', {}), { style: { background: 'var(--dsw-alias-bg-layer-2)' } }),
    ),
  );

  const backupsBody = (): React.ReactElement => React.createElement('div', null,
    React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', padding: '6px 0' } },
      '备份目录: ' + (state.backupDir || '') + '（与 Pi 完全隔离，只保留最新一份快照）'),
    backups.length === 0
      ? React.createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', padding: '8px 0' } }, '（尚无备份，可手动备份或等待自动备份）')
      : backups.map((b) => React.createElement('div', {
          key: b.name,
          style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', fontSize: 13, borderBottom: '1px solid var(--dsw-alias-border-l1)' },
        },
          React.createElement('span', null, b.name),
          React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, b.files + ' 个文件'),
        )),
    React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '12px 0 2px' } },
      btn('立即备份', () => mutate('backup', {}), { style: { background: 'var(--dsw-alias-bg-layer-2)' } }),
      confirmRestore
        ? React.createElement(React.Fragment, null,
            React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)' } }, '确认用最新备份覆盖当前记忆?'),
            btn('确认恢复', () => mutate('restoreLatest', {}), { style: { background: 'var(--dsw-alias-state-error-primary)', borderColor: 'transparent', color: '#fff' } }),
            btn('取消', () => setConfirmRestore(false)),
          )
        : btn('从最新备份恢复', () => setConfirmRestore(true), { style: { background: 'var(--dsw-alias-bg-layer-2)' } }),
    ),
    React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', padding: '6px 0' } },
      '自动备份间隔由插件配置中的「自动备份间隔」控制；Pi 记忆丢失时默认自动切回本地并恢复。'),
  );

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
            });
          } else if (f.type === 'number') {
            control = numberInput(val, setVal, '');
          } else if (f.type === 'select') {
            control = React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
              (f.options || []).map((opt) => {
                const active = String(val) === opt;
                return btn(opt, () => setVal(opt), {
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
                  input(val, setVal, '模型名'),
                  modelStatusLine(),
                  React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: '8px 0 4px' } }, '已下载模型（点击选用）'),
                  React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                    (m.models || []).map((mo) => {
                      const active = String(val) === mo.name;
                      return btn(mo.name, () => setVal(mo.name), {
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
              : input(val, setVal, '');
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
        '所有配置写回当前 profile 的 cordis.patch.yml（persona-memory 段），重启 web 后生效'),
      groups,
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 } },
        // Default button look (no brand override): --dsw-alias-brand-primary is
        // undefined in the web shell, which rendered this CTA as a white blank.
        btn('保存全部配置', saveConfig, { style: { fontWeight: 600 } }),
        React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)' } }, '保存后需重启 web 生效'),
      ),
    );
  };

  const standingSummary = standing.length + ' 条' + ((state.standing || {}).chars ? ' · ' + (state.standing || {}).chars + ' 字符' : '');
  const memStore = st.memory || {};
  const usrStore = st.user || {};
  const failStore = st.failure || {};
  const filesSummary = (memStore.exists ? 'MEMORY ' + memStore.usagePct + '%' : '') + ' · '
    + (usrStore.exists ? 'USER ' + usrStore.usagePct + '%' : '') + ' · '
    + (failStore.exists ? 'FAIL ' + failStore.usagePct + '%' : '');
  const idxSummary = (idx.fts && idx.fts.exists ? 'FTS5 ' + fmtBytes(idx.fts.size) : 'FTS5 未生成') + ' · '
    + (idx.vector && idx.vector.exists ? '向量 ' + fmtBytes(idx.vector.size) : '向量未启用');
  const projectsSummary = projects.length + ' 个';
  const backupsSummary = backups.length > 0 ? backups[0].files + ' 文件' : '无';
  const configSummary = (state.schema || []).length + ' 项';

  return React.createElement('div', { style: { maxWidth: 720 } },
    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
      React.createElement('div', { style: { fontWeight: 600, fontSize: 15 } }, '记忆管理'),
      React.createElement('div', { style: { display: 'flex', gap: 8 } },
        btn(busy ? '处理中' : '刷新', load)),
    ),
    notice ? React.createElement('div', {
      style: {
        fontSize: 13,
        color: /失败|失败|错误/.test(notice) ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)',
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
          React.createElement('div', { style: { flex: 1 } }, input(newStanding, setNewStanding, '新增常驻指令...')),
          btn('添加', () => mutate('standingAdd', { text: newStanding })),
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
