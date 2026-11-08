# 项目记忆（AGENTS.md 索引 + memory/ 主题文件）

项目记忆跟着仓库走，不再集中存放在插件目录下。

## 布局

```
<git 仓库根>/
├── AGENTS.md      ← 常驻区（原样注入）+ 末尾 @memory/*.md 索引行
└── memory/        ← 一主题一文件，按需读取
    ├── architecture.md
    ├── deployment.md
    └── .trash/    ← 删除的文件（可恢复）
```

- **项目根** = git 主仓库根（`findGitRepoRoot` 纯 fs 探测；linked worktree 通过 `commondir` 回溯到主仓库，所有 worktree 共享一份记忆）；非 git 目录退化为会话 cwd；家目录与文件系统根不算项目。
- **AGENTS.md 由宿主 `@deepseek-ai/dsh-agent-instructions` 整份注入**，所以常驻区天然每次请求生效。插件只额外注入"索引是懒加载、需要时读"的约定，不重复注入条目本身。
- linked worktree 例外：宿主的发现规则会把根定在 worktree，而记忆在主仓库根——此时插件自行补上常驻区，保证规则不丢。

## 格式

索引行是唯一机器可读部分，**行级识别**：

```markdown
- 构建：先 npm run build，再 remove+add 重装（pnpm store 有缓存）

@memory/architecture.md — 模块地图、注入顺序、自动能力
@memory/pitfalls.md: 已知坑与排查路径
```

- 识别规则：`@memory/<path>.md`，可选 `—` / `–` / `--` / `:` 分隔的描述；允许 `-` / `*` / `+` 列表前缀。
- 其余内容全部算常驻区，**原样保留**（插件从不改写你的措辞）。
- 无常驻内容时文件只有 `@` 行，即规范形态。
- 三个预算：常驻区 `projectResidentCharLimit`（6000）、索引区 `projectIndexCharLimit`（4000）、单文件 `projectFileCharLimit`（20000）。**超预算拒绝写入，绝不静默裁剪**——被悄悄丢掉的常驻规则正是这个文件要防的事故。

## 工具：`project_memory`

作用域固定为当前会话的项目（**没有 `project` 参数**——能任意指名项目就能任意写路径）。

| action | 作用 |
|---|---|
| `list` | 索引 + 孤儿文件 + 各区用量 |
| `read` | 读一个主题文件全文 |
| `write` | 新建/覆盖主题文件（带 `summary`，自动补索引行） |
| `append` | 追加一节到已有主题文件 |
| `update` | 按子串就地替换一行：给 `file` 改主题文件行，不给则改常驻区行 |
| `delete` | 删索引行 + 文件移入 `memory/.trash/` |
| `search` | 跨主题文件子串检索（AND 语义） |
| `add_resident` / `remove_resident` | 增删常驻区整行 |
| `migrate` | 把散文式 AGENTS.md 拆成常驻 + 索引（见 [project-migration.md](project-migration.md)） |
| `guide` | 取完整写法指南 |

`update` 是 0.0.4 起对 `remove_resident` + `add_resident` 两步的替代。

## 写法指南（内置 prompt）

机制本身不教模型**该怎么写**——只给工具，模型会把散文塞进常驻区，或者把所有内容塞进 `memory/all.md`。所以指南是插件的一部分（`lib/project-guide.ts`，单一真源，两种尺寸）：

- **每请求注入（约 330 字符）**：两区定义 + 记账前先 `list` 看同主题 + 细节进主题文件 + 跨项目偏好走全局 `memory`。
- **空仓库引导（`projectBootstrapHint`）**：无 `AGENTS.md` 的 git 仓库里补一句「本仓库还没有项目记忆」+ 上面四条要点。
- **完整指南（`project_memory guide`，约 3300 字符，不常驻）**：两区该放什么、边界表与三条判据、创建与维护流程、真实示例、反模式清单。
- 管理页「项目记忆」卡顶部有同一份指南的展开面板（`/api/persona-memory/projectGuide`），保证人和模型看到的是同一段文字。

## 管理页

「记忆管理 → 项目记忆」：每个项目显示根路径 → 常驻区（预算条 + 可整段编辑）→ 索引行（`@memory/x.md — 描述` + 编辑/删除）→ 未索引的孤儿文件 → 新建 / 迁移 / 手动登记路径。

- 「编辑」打开的是**索引指向文件的全文**；「删除」= 删索引行 + 文件移入 `memory/.trash/`。
- 写路由只接受注册表内的项目名，不接受浏览器传来的路径。
- 「刷新」在任意请求处理中变成禁用的「处理中」，并配实时进度条；进度由 `GET /api/persona-memory/projectMigrateStatus` 每秒轮询。

## 注册表

记忆散落在各仓库，没有统一目录可扫，所以 `<dir>/project-registry.json` 记录见过的项目根（`name → root`）。管理页与备份都基于它；某个根消失时标记为 `missing` 而不删记录，恢复检出后自动重新可用。

## 备份

项目记忆按注册表快照进 `$DSH_HOME/memory-backup/`：

- `latest/` 是**精确镜像**（每次整体换新，不累积幽灵文件）；
- `history/<时间戳>/` 是带日期的历史快照，保留份数由 `backupKeep` 决定（默认 10）；
- 管理页对每一份快照都提供独立「恢复」按钮，不限于最新。
