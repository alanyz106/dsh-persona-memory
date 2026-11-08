# dsh-persona-memory

> [Quophic/dsh-persona-memory](https://github.com/Quophic/dsh-persona-memory) 的派生版；npm 包名 `@alanyz106/dsh-persona-memory`。

持久化长期人格记忆插件，面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）。

让 agent 跨会话记住用户、项目与教训：事实落盘永久保存、每次请求注入上下文；后台学习、纠正检测、失败记忆、容量合并让记忆「自己长出来且不失控」。

**这份 README 是索引，不是说明书。** 细节按需点进 `doc/` 对应文件，避免每次都要通读全文。

---

## 三个区，一句话

| 区 | 位置 | 何时加载 |
|---|---|---|
| 全局记忆 | `$DSH_HOME/memory/MEMORY.md` · `USER.md` · `failures.md` | 每请求注入（按预算截断） |
| 项目记忆 | 各仓库 `AGENTS.md`（常驻区 + `@memory/*.md` 索引）+ `memory/` | 常驻区随仓库注入；主题文件按需读 |
| 常驻指令 | `$DSH_HOME/memory/STANDING.md` | 每请求注入，**只有用户能写** |

判据：换仓库还成立 → 全局；只在这个仓库成立 → 项目；用户亲口要求、始终生效 → 常驻指令。

---

## 索引

### 用

| 想做的事 | 看这里 |
|---|---|
| 装 / 升级 / 换 profile | [doc/install.md](doc/install.md) |
| 查某个配置项的默认值 | [doc/config.md](doc/config.md) |
| 用哪个工具、哪个 action | [doc/tools.md](doc/tools.md) |
| 常驻指令怎么管 | [doc/standing.md](doc/standing.md) |

### 项目记忆

| 想做的事 | 看这里 |
|---|---|
| 两区怎么划、`AGENTS.md` 怎么排 | [doc/project-memory.md](doc/project-memory.md) |
| 把散文式 `AGENTS.md` 拆成索引 | [doc/project-migration.md](doc/project-migration.md) |

### 记忆怎么长出来

| 想做的事 | 看这里 |
|---|---|
| 自动学习 / 纠正 / 失败记忆 / 合并 | [doc/automation.md](doc/automation.md) |
| 磁盘上是什么格式、怎么和 Pi 共存 | [doc/disk-format.md](doc/disk-format.md) |
| 语义向量检索、CJK 检索 | [doc/vector-search.md](doc/vector-search.md) |

### 开发

| 想做的事 | 看这里 |
|---|---|
| 跑测试、加测试 | [doc/testing.md](doc/testing.md) |
| 哪些代码借鉴了 hermes | [doc/credits.md](doc/credits.md) |

---

## 能力速查

**存储**：跨会话持久化、每请求注入、项目记忆随仓库提交/回滚、记忆老化（`created/last`）。

**工具**：`memory`（全局读写）、`memory_search`（FTS5 + 可选向量 RRF）、`project_memory`（12 个 action）、`/standing`、`/correct`。

**自动化**：后台学习（默认关）、纠正检测、失败记忆注入、超限自动合并。

**安全**：每次写入过内容扫描（注入载荷 / 凭据 / 不可见 Unicode）；常驻指令模型无写入口；项目记忆路径全过 `safeMemoryRel`；管理接口要求在回环。

**WebUI**：设置页「记忆管理」——常驻指令、三记忆文件、项目记忆卡（含迁移与实时进度）、索引状态、插件配置、本地备份与逐份恢复。

---

## 版本与许可

当前 `0.0.8`。MIT，借鉴来源详见 [doc/credits.md](doc/credits.md)。
