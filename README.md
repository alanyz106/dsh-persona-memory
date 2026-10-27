# dsh-persona-memory

> 本仓库是 [Quophic/dsh-persona-memory](https://github.com/Quophic/dsh-persona-memory) 的派生版本，npm 包名 `@alanyz106/dsh-persona-memory`（上游包名归其作者所有）。

持久化长期人格记忆插件 for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）。

让 agent 跨会话记住用户、项目与教训：事实写入磁盘永久保存，每次请求注入上下文；后台自动学习、纠正检测、失败记忆、容量合并让记忆"自己长出来且不失控"。

**项目记忆（0.3.0 起）**：每个 Git 仓库在自己的根目录维护一份 `AGENTS.md`——常驻区（每次请求注入的硬约束）+ 末尾 `@memory/*.md` 索引行；真正的项目知识按主题分文件放在 `memory/` 下，模型按需读取。记忆跟着仓库走，可以随代码一起提交、评审、回滚。

---

## 功能清单

### A. 存储与共享

| 功能 | 说明 |
|---|---|
| 跨会话持久记忆 | `MEMORY.md`（事实/偏好/约定/环境）+ `USER.md`（用户画像），写入即永久保存 |
| 每请求上下文注入 | 每次请求自动把当前记忆注入系统提示词（`memory:profile` 段，按字符预算截断） |
| 全局记忆 | `MEMORY.md` / `USER.md` / `failures.md` / `STANDING.md` 存在 `<dir>`（默认 `$DSH_HOME/memory`） |
| 项目级记忆 | 项目根 `AGENTS.md`（常驻区 + `@memory/*.md` 索引）+ `memory/` 主题文件；git 仓库根为身份（worktree 共享），按会话 cwd 自动注入索引与加载约定（`memory:project` 段） |
| 项目记忆随仓库走 | 记忆文件就在仓库里，可 commit / review / revert；删除的文件移入 `memory/.trash/` 可恢复 |
| 记忆老化 | 条目携带 `created/last` 日期，合并时据此判断陈旧条目 |

### B. 读写与检索工具

| 功能 | 说明 |
|---|---|
| `memory` 工具 | `read` / `add` / `update` / `delete` / `rewrite`；`which` 选 memory/user/failure（全局记忆） |
| `project_memory` 工具 | `list` / `read` / `write` / `append` / `delete` / `search` / `add_resident` / `remove_resident` / `migrate`；作用域固定为当前会话的项目，无 project 参数（防任意路径写） |
| `memory_search`（混合检索，全局记忆） | 优先 **FTS5 + 语义向量（RRF 融合）**：FTS5 全文索引（`<dir>/.memory-index.sqlite`，mtime 自动重建）+ 向量索引（`vectorIndexDir` 下 `.memory-vec.sqlite`，只存 embedding、指纹增量同步、纯 JS 余弦）；向量未启用时走 FTS5，SQLite 不可用时回退子串扫描；结果始终 ≤`searchMaxResults` 条、只进工具输出，注入成本不随检索方式增加 |
| 用量提示 | 所有 `memory` 操作返回用量百分比；达 90%（`usageNudgeThreshold`）提醒用 `rewrite` 合并 |
| `/standing` 命令 | 用户管理常驻指令（列出 / add / remove / clear） |
| WebUI 记忆管理页 | 设置页「记忆管理」区块（`settings.section` slot）：常驻指令增删改、三记忆文件条目编辑/删除、**项目记忆卡**（常驻区编辑 + `@` 索引行按文件编辑/删除 + 孤儿文件 + 新建 + 迁移 + 手动登记）、FTS5/向量索引状态与重建、向量搜索配置、已下载模型扫描与缓存检测、**插件配置卡**（schema 驱动全量配置）、**本地备份卡**（立即备份/恢复、自动备份；项目记忆按注册表快照） |

### C. 自动学习机制

| 功能 | 说明 |
|---|---|
| 后台学习 | 每 `learnIntervalTurns`（默认 10）轮用会话自身 LLM 路由复习近期对话，自动提取持久事实存入记忆 |
| 纠正检测 | `/feedback` 事件 + 对话内模式检测（强/弱/负向模式 + 指令词，仅直接人工消息，3 轮限频）→ 立即存 `[correction]` 失败条目 |
| 失败记忆 | `failures.md` 结构化记录 `[category] 内容 — Failed: 原因 — Corrected to: 修正`；最近 7 天最多 5 条自动注入上下文（`memory:failures` 段），防止重蹈覆辙 |
| 自动合并 | 记忆超限时用 LLM 合并精简（>30 天无引用可删、偏好/纠正优先保留）；**只有结果严格更小、可解析且过扫描才提交**，失败绝不损坏记忆 |

### D. 安全与约束

| 功能 | 说明 |
|---|---|
| 内容扫描 | 每次写入过安检：提示注入/数据外泄载荷、API key/token/私钥、不可见 Unicode 字符一律拦截（防凭据落盘、防记忆被植入恶意指令） |
| 常驻指令 | STANDING.md 每行一条、硬预算（20 条/2000 字符）、始终注入（`memory:standing` 段，早于其他记忆）；**只有 `/standing` 命令或直接编辑能写**——模型无写入口，防止模型把"常驻指令"偷偷注入 |
| 会话分级 | 子代理/派生会话（subagent、workflow 子会话、AgentTeams 成员）**不注入记忆、不参与后台学习、不产生纠正条目**（`injectHumanOnly` / `learnHumanOnly` / `correctionHumanOnly`，默认全开）；人类主会话行为不变 |

### E. 工程与容错

| 功能 | 说明 |
|---|---|
| 原子写 + 单锁串行队列 | 临时文件 + rename，崩溃不留半截文件；add/update/remove 走单锁原子读-改-写（`mutate`），并发工具调用绝不互相覆盖；只读/纯写各自加锁 |
| 跨进程写保护 | 写前 sha256 指纹预检（对照 Pi 的 ExternalMemoryWriteConflict）：外部（Pi/手动编辑）改过就不覆盖，重试一次后返回 `conflict` 提示 |
| 字节格式稳定性 | 无尾随换行、charCount 含分隔符、USER 上限 5000、超限拒绝写入、注入 `<memory-context>` 围栏 |
| 路径安全闸门 | 项目记忆的每个路径（工具参数、管理页 body、迁移产物）都过 `safeMemoryRel`：必须 `memory/**.md`、无 `..`、无绝对路径、无 dotfile、resolve 后仍在 `memory/` 内（含符号链接逃逸检查） |
| 优雅降级 | FTS5 不可用回退子串搜索；SQLite 动态 import，插件绝不硬依赖 |
| 226 项冒烟测试 | 验证存储格式、解析、读写、扫描、合并、项目根探测、索引解析、路径安全、迁移校验、备份恢复、纠正、FTS、向量索引、溢出拒绝、并发全链路 |
---

## 借鉴来源（明确声明）

本插件大量借鉴 [pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory)（MIT，作者 chandra447，其本身移植自 [hermes-agent](https://github.com/anthropics/hermes-agent)）。按借鉴程度分四档：

### 1. 代码级移植（近逐行，MIT 保留声明）

| 文件 | 来源 | 移植内容 |
|---|---|---|
| `lib/secret-scanner.ts` | hermes `content-scanner.ts` | 11 条提示注入/外泄威胁模式 + 19 条凭据模式 + 不可见 Unicode 字符集 |
| `lib/standing.ts`（核心） | hermes `standing-instructions.ts` | 容错解析（`#` 注释/`-`/`*` 列表符/去重）、硬预算（20 条/2000 字符）、`<standing-instructions>` 渲染块（超预算在块内声明遗漏）、来源约束（仅用户可写） |
| `lib/correction.ts` | hermes `correction-detector.ts` 的模式部分 | 强/弱/负向三组正则 + 23 个指令词 + `extractCorrectionDirective` |

### 2. 格式级兼容（字节兼容，实现重写）

| 文件 | 来源 | 兼容内容 |
|---|---|---|
| `lib/memory-store.ts`（磁盘格式） | hermes `MemoryStore` | `\n§\n` 分隔符、`encodeEntry`/`decodeEntry` 正则（含 `project64` 字段）、`YYYY-MM-DD` 日期 |
| `lib/failures.ts` | hermes `buildFailureMemoryText` | `[category] 内容 — Failed: … — Corrected to: …` 结构化文本 |
| （已弃用）`lib/projects.ts` 的 Pi 项目根解析 | hermes `project.ts` / `paths.ts` | 0.3.0 起只保留其中「git 仓库根身份（worktree 共享）」的探测思路，`projects-memory/` 路径与迁移桥已删除 |

### 3. 概念级移植（思路照搬，代码全新）

| 功能 | 来源概念 | 本插件实现 |
|---|---|---|
| 后台学习 | hermes 每 10 轮复习 | DSH `session/event` 钩子 + `ctx.llm.stream` + 自写提示词 |
| 自动合并 | hermes `auto-consolidate.ts` | 超限触发、合并规则、**严格更小才提交**安全护栏 |
| 纠正检测落库 | hermes 自动失败捕获 | `feedback/record` 事件 + 对话内模式 → `[correction]` 失败条目 |
| 记忆老化 | hermes Memory Aging | `created/last` 日期驱动合并决策 |

### 4. DSH 原生（未借鉴 hermes，基于 DSH API 构建）

| 模块 | 基于的 DSH 能力 |
|---|---|
| `memory` / `memory_search` 工具 | `ctx.tools.register` + `defineTool` |
| 记忆注入段落 | `ctx.systemPrompt` 注册表（variable + section） |
| `/standing` 命令 | `ctx.commands` 注册 |
| `lib/llm-helper.ts` | 会话 `request/header` 路由解析 + `ctx.llm.stream` |
| `lib/fts.ts` | `node:sqlite` FTS5（DSH `dsh-session-query-sqlite` 同款契约） |
| `lib/project-memory.ts` / `project-registry.ts` / `project-migrate.ts` / `project-memory-tool.ts` | 全新设计：仓库内 `AGENTS.md` 索引 + `memory/` 主题文件、注册表、LLM 迁移闸门 |
| 存储实现（原子写/队列/API） | 全新编写（hermes 的 MemoryStore 耦合 Pi API，无法直接复用） |

> 刻意未移植：hermes 的 SQLite 会话搜索（DSH 原生 `dsh-session-query-sqlite` 已具备）、程序性技能（DSH 原生 skills 已具备）、子进程传输与 SQLite 锁协调器（DSH 插件进程内运行，不需要）。

---

## 工具与命令

| 工具/命令 | 说明 |
|---|---|
| `memory` | 全局记忆：`read` / `add` / `update` / `delete` / `rewrite`，`which` 选 `memory` / `user` / `failure`；failure 支持 `category` / `failure_reason` / `corrected_to` |
| `memory_search` | 全局记忆检索：`query` + 可选 `which`（`memory`/`user`/`failure`/`all`） |
| `project_memory` | 项目记忆：`list` / `read` / `write` / `append` / `delete` / `search` / `add_resident` / `remove_resident` / `migrate`；作用域为当前项目 |
| `/standing` | 列出常驻指令 |
| `/standing add <文本>` | 钉住一条常驻指令 |
| `/standing remove <n>` | 按 1 起编号移除 |
| `/standing clear` | 清空 |

## 安装到 DSH profile

**兼容范围**：dsh `0.1.0-rc.6 ~ 0.2.x`（peer 范围 `^0.1.0-rc.6 || ^0.2.0-rc.1`）。桌面版（Desktop profile）与 npm 版（web profile）都能装；0.2.x 起 dsh 会按 peer 范围做版本闸门，声明不匹配会被判 `incompatible-version` 并拒绝加载。

源码为 **TypeScript**（`index.ts` + `lib/*.ts` + `client/src/*.ts`），发布产物由构建生成：`npm run build`（tsc 编译 Host 半区到 `dist/` + esbuild 打包 Client bundle 到 `client/client.js`）。本地路径安装前需先构建。

插件声明了 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，安装后 dsh **自动激活**为 profile 层（无需手动挂载）：

```bash
# 构建（本地路径开发每次改代码后必做）
npm run build

# 安装（npm / CLI 版，web profile）
dsh plugin --profile web add @alanyz106/dsh-persona-memory
# 或从本地副本：dsh plugin --profile web add file:<本仓库路径>

# 安装（桌面版 0.2.x，desktop profile；用安装目录自带的 CLI）
"D:/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd" plugin --profile desktop add file:E:/GitHub/lian_dsh

# 重启 dsh web
dsh --profile web
```

file: 安装是真实副本——改代码后须重新构建、`dsh plugin --profile web remove @alanyz106/dsh-persona-memory` 再 add（pnpm 有 store 缓存，只 add 可能装旧副本），最后重启 web。

如需覆盖配置（如 `dir`），在 profile 的 `cordis.patch.yml` 里按 id 覆盖即可（bundle 行在后层会被 profile 行覆盖）：

```yaml
- id: persona-memory
  config:
    dir: C:/Users/Quophic/.pi/agent/pi-hermes-memory
```

## 配置（均可选）

| 键 | 默认 | 含义 |
|---|---|---|
| `dir` | 见下 | 记忆文件目录；显式设置优先 |
| `memoryCharLimit` | `5000` | MEMORY.md 注入上下文的最大字符数 |
| `userCharLimit` | `8000` | USER.md 注入上下文的最大字符数 |
| `enableSecretScanning` | `true` | 是否启用写入扫描 |
| `inject` | `true` | 是否注册系统提示词注入段落 |
| `injectHumanOnly` | `true` | 仅人类驱动的主会话注入记忆；子代理/派生会话不注入（继承父会话上下文） |
| `sectionOrder` | `55` | 注入段落在系统提示词中的顺序 |
| `searchMaxResults` | `10` | `memory_search` 单次最多返回条数 |
| `usageNudgeThreshold` | `0.9` | 达到该用量比例（如 90%）时在结果中提醒合并 |
| `correctionDetection` | `true` | 收到 `feedback/record` 时自动存 `[correction]` 失败条目 |
| `correctionPatternDetection` | `true` | 对话内纠正模式检测（强/弱/负向模式，仅直接人工消息） |
| `correctionHumanOnly` | `true` | 仅人类驱动的主会话做纠正检测；派生会话不产生纠正条目 |
| `correctionRateLimitTurns` | `3` | 对话内纠正保存的最小间隔（轮） |
| `memoryFtsEnabled` | `true` | 启用 SQLite FTS5 记忆镜像（`memory_search` 全文检索） |
| `vectorEnabled` | `false` | 启用语义向量搜索（`memory_search` 变混合检索：FTS5 + 向量 RRF 融合） |
| `vectorIndexDir` | `$DSH_HOME/memory` | 向量索引目录（DSH 侧，绝不写入 Pi 共享记忆目录） |
| `embeddingProvider` | `remote` | `remote`（OpenAI 兼容 `/embeddings` API）或 `local`（自带 transformers.js，模型自动下载） |
| `embeddingBaseUrl` | `''` | 远程 embedding API 基址（如 `https://api.openai.com/v1`） |
| `embeddingApiKey` | `''` | 远程 embedding API Key；不填则读 `DSH_EMBEDDING_API_KEY` 环境变量 |
| `embeddingModel` | `text-embedding-3-small` | embedding 模型名（local 默认 `Xenova/all-MiniLM-L6-v2`） |
| `embeddingCacheDir` | `$DSH_HOME/models` | local 模型缓存目录（首次自动下载到此处） |
| `embeddingRemoteHost` | `https://huggingface.co` | local 模型下载源；大陆可用 `https://hf-mirror.com` |
| `adminProfile` | `web` | 记忆管理页配置写回的目标 profile（`~/.dsh/profiles/<名>/cordis.patch.yml`） |
| `autoBackupMin` | `60` | 自动备份间隔（分钟）；`0` 关闭；只保留最新一份快照到 `$DSH_HOME/memory-backup/latest/` |
| `autoSwitchOnPiLoss` | `true` | Pi 共享记忆丢失（曾见 MEMORY.md 后消失）时自动切到 `$DSH_HOME/memory` 并从最新备份恢复 |
| `learnEnabled` | `true` | 是否启用后台自动学习 |
| `learnHumanOnly` | `true` | 仅人类驱动的主会话做后台学习；子代理/派生会话的对话不写入记忆 |
| `learnIntervalTurns` | `10` | 每 N 轮（turn/end）触发一次复习 |
| `learnRecentTurns` | `2` | 每次复习取最近多少个轮次的对话 |
| `learnMaxChars` | `6000` | 复习用的对话/记忆摘要最大字符数 |
| `learnTimeoutMs` | `120000` | 学习 LLM 调用的超时 |
| `standingEnabled` | `true` | 是否启用常驻指令（STANDING.md + `/standing` 命令） |
| `standingCharLimit` | `2000` | STANDING.md 注入预算（硬上限） |
| `standingMaxEntries` | `20` | STANDING.md 最大条数（硬上限） |
| `autoConsolidate` | `true` | 超限时自动 LLM 合并（严格更小才提交） |
| `consolidateStaleDays` | `30` | 合并时判定"陈旧可删"的天数（无近期引用） |
| `consolidateTimeoutMs` | `120000` | 合并 LLM 调用的超时 |
| `failureInjectionEnabled` | `true` | 是否注入最近失败（learn from mistakes） |
| `failureMaxAgeDays` | `7` | 失败注入窗口（按 created 日期） |
| `failureMaxEntries` | `5` | 失败注入最多条数 |
| `failureCharLimit` | `10000` | failures.md 字符上限（hermes 默认 memory×2） |
| `projectEnabled` | `true` | 是否启用项目级记忆（注册 `project_memory` 工具 + 注入项目段） |
| `projectFileCharLimit` | `20000` | 单个 `memory/<主题>.md` 的字符上限 |
| `projectResidentCharLimit` | `3000` | `AGENTS.md` 常驻区字符预算（每次请求都注入，只放操作性硬约束） |
| `projectIndexCharLimit` | `4000` | `AGENTS.md` 索引区（`@memory/...` 行）字符预算 |
| `projectAutoMigrate` | `true` | 首次写入遇到 prose `AGENTS.md` 时，是否允许辅助 LLM 自动拆成常驻 + 索引 |

`dir` 默认解析顺序：① 显式 `config.dir` → ② `~/.pi/agent/pi-hermes-memory`（若已存在 `MEMORY.md`，即与 Pi 共用）→ ③ `$DSH_HOME/memory`（默认 `~/.dsh/memory`）。

## 磁盘格式（与 pi-hermes-memory 一致）

```markdown
<条目文本> <!-- created=2026-08-13, last=2026-08-13 -->
§
<另一条目文本> <!-- created=2026-08-13, last=2026-08-13 -->
```

- 条目以 `\n§\n` 分隔，每条是单行文本 + 行尾 `<!-- created=YYYY-MM-DD, last=YYYY-MM-DD -->` 注释。
- 无注释的旧条目照常解析（日期默认为今天）。
- 写入采用原子写（临时文件 + rename），并按文件串行化，避免并发工具调用互相覆盖。
- STANDING.md 例外：每行一条，无分隔符、无元数据（见下节）。

## 语义向量搜索（可选，默认关闭）

`memory_search` 默认走 **FTS5 全文检索**（字面匹配）；开启 `vectorEnabled` 后升级为**混合检索**：

- **存储不变**：MEMORY.md / USER.md / failures.md 仍是唯一真相源，与 Pi 逐字节共用不变。
- **索引在 DSH 侧**：`.memory-vec.sqlite` 存在 `vectorIndexDir`（默认 `$DSH_HOME/memory`），**只存 embedding 数据**（每条记忆的向量 BLOB + sha256 指纹），Pi 完全不感知；索引可随时删除重建。
- **指纹增量同步**：每次搜索前对比文件条目 sha256，**只对新增/变化的条目重新 embedding**——Pi 改共享文件后自动跟上，不重复计算存量。
- **混合排序**：FTS5 精确匹配 + 向量语义匹配通过 **RRF（倒数排名融合）** 合并，精确词与近义命中互相补足；向量不可用自动降级 FTS5/子串。
- **注入成本不变**：结果仍 ≤`searchMaxResults` 条、只进工具输出，不常驻上下文。

启用示例（profile 的 cordis.patch.yml 覆盖）：

```yaml
- id: persona-memory
  config:
    vectorEnabled: true
    embeddingProvider: local
    # embeddingModel: Xenova/all-MiniLM-L6-v2   # 默认，可换
    # embeddingCacheDir: C:/Users/xxx/.dsh/models # 默认 $DSH_HOME/models
    # embeddingRemoteHost: https://hf-mirror.com  # 大陆镜像（可选）
```

> **本地模型自动下载**：`embeddingProvider: local` 时，插件自带 `@xenova/transformers`，**首次使用自动从 HuggingFace 下载模型**（默认 `Xenova/all-MiniLM-L6-v2`，约 80MB）到 `$DSH_HOME/models`，之后完全离线运行；下载进度会打印到 dsh 日志。网络受限时可用 `embeddingRemoteHost: https://hf-mirror.com` 走镜像，或预下载模型放入 `embeddingCacheDir`。
>
> 远程方案（备选）：`embeddingProvider: remote` + `embeddingBaseUrl`（如 `https://api.openai.com/v1`）+ `embeddingApiKey`（或 `DSH_EMBEDDING_API_KEY` 环境变量）。DeepSeek 官方 `/v1/embeddings` 接口曾出现可用性问题（见 [deepseek-ai/DeepSeek-R1#652](https://github.com/deepseek-ai/DeepSeek-R1/issues/652)），不建议依赖。

## 常驻指令（STANDING.md）

与 pi-hermes-memory 一致：**每行一条**，无分隔符、无元数据；容忍空行、`#` 注释和行首 `-`/`*` 列表符，手改时仍是普通 Markdown。注入块用 `<standing-instructions>` 围栏，声明"用户亲写的规则、始终生效、高于默认行为"；超预算时在块**内部**声明被省略的条数，绝不静默丢弃。

**来源约束**：只有 `/standing` 命令或用户直接编辑文件能写入——模型无写入口（后台学习、合并、纠正检测都不碰它）。

## 项目记忆（AGENTS.md 索引 + memory/ 主题文件）

项目记忆跟着仓库走，不再集中存放在插件目录下。

### 布局

```
<git 仓库根>/
├── AGENTS.md      ← 常驻区（原样注入）+ 末尾 @memory/*.md 索引行
└── memory/        ← 一主题一文件，按需读取
    ├── architecture.md
    ├── deployment.md
    └── .trash/    ← 删除的文件（可恢复）
```

- **项目根** = git 主仓库根（`findGitRepoRoot` 纯 fs 探测，linked worktree 通过 `commondir` 回溯到主仓库，所有 worktree 共享一份记忆）；非 git 目录退化为会话 cwd；家目录与文件系统根不算项目。
- **AGENTS.md 由宿主 `@deepseek-ai/dsh-agent-instructions` 整份注入**，所以常驻区天然每次请求生效。插件只额外注入"索引是懒加载、需要时读"的约定，不重复注入条目本身。
- linked worktree 例外：宿主的发现规则会把根定在 worktree（`.git` 是文件），而记忆在主仓库根——此时插件自行补上常驻区，保证规则不丢。

### 格式

索引行是唯一机器可读部分，**行级识别**：

```markdown
- 构建：先 npm run build，再 remove+add 重装（pnpm store 有缓存）

@memory/architecture.md — 模块地图、注入顺序、自动能力
@memory/pitfalls.md: 已知坑与排查路径
```

- 识别规则：`@memory/<path>.md`，可选 `—` / `–` / `--` / `:` 分隔的描述；允许 `-` / `*` / `+` 列表前缀。
- 其余内容全部算常驻区，**原样保留**（插件从不改写你的措辞）。
- 无常驻内容时文件只有 `@` 行，即规范形态。
- 三个预算：常驻区 `projectResidentCharLimit`（3000）、索引区 `projectIndexCharLimit`（4000）、单文件 `projectFileCharLimit`（20000）。**超预算拒绝写入，绝不静默裁剪**——被悄悄丢掉的常驻规则正是这个文件要防的事故。

### 工具：`project_memory`

作用域固定为当前会话的项目（**没有 `project` 参数**——能任意指名项目就能任意写路径）。`list` / `read` / `write` / `append` / `delete` / `search` / `add_resident` / `remove_resident` / `migrate`。写入自动维护索引行：新建文件补一行，改描述更新该行，删除文件同时移除指针并把文件移进 `memory/.trash/`。

### 迁移已有 AGENTS.md

首次写入遇到散文式 `AGENTS.md` 时（`projectAutoMigrate: true`），用**会话自身的模型路由**规划拆分：

1. 常驻区只留操作性硬约束（构建/测试命令、禁改清单、部署约束、必守规范），原文措辞不动；
2. 其余按主题拆进 `memory/<topic>.md`；
3. **校验闸门**：计划必须可解析、每个文件路径过 `safeMemoryRel`、内容过 scanner、不超预算，且**原文每个标题都必须能在常驻区或某个主题文件里找到**——任一不满足就整份放弃、文件不动；
4. 通过后原文另存 `AGENTS.md.bak-<时间戳>`，再写主题文件与新的 `AGENTS.md`。

### 管理页

「记忆管理 → 项目记忆」：每个项目显示根路径 → 常驻区（预算条 + 可整段编辑）→ 索引行（`@memory/x.md — 描述` + 编辑/删除）→ 未索引的孤儿文件 → 新建 / 迁移 / 手动登记路径。「编辑」打开的是**索引指向文件的全文**；「删除」= 删索引行 + 文件移入 `memory/.trash/`。写路由只接受注册表内的项目名，不接受浏览器传来的路径。

### 注册表

记忆散落在各仓库，没有统一目录可扫，所以 `<dir>/project-registry.json` 记录见过的项目根（`name → root`）。管理页与备份都基于它；某个根消失时标记为 `missing` 而不删记录，恢复检出后自动重新可用。

## 与 Pi 共用的注意点

- **避免同时写**：两边都是原子写，但 Pi 有跨进程锁（`.pi-hermes-locks.sqlite` + recovery 文件），DSH 侧用**写前指纹预检**兜底——检测到外部改动就不覆盖并提示冲突。极端并发下仍可能互相感知不到，**不同时运行最安全**。
- 覆盖的全局文件：`MEMORY.md` / `USER.md` / `STANDING.md` / `failures.md`。
- 两边扫描标准一致（同一份 content-scanner 移植），hermes 写入的内容 DSH 直接可读，反之亦然；磁盘格式（含无尾随换行、project64、超限拒绝）已对齐 Pi v0.9.4 实测。
- **项目记忆不再与 Pi 共用**：0.3.0 起改为仓库内的 `AGENTS.md` + `memory/`，Pi 的 `projects-memory/` 目录不再读取、也不再写入（旧目录原样留在磁盘，不自动迁移）。

## 许可与致谢

MIT。磁盘格式、内容扫描器、常驻指令、纠正模式与合并策略移植自 [pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory)（MIT，作者 chandra447），其本身又移植自 [hermes-agent](https://github.com/anthropics/hermes-agent)。具体移植清单见上文「借鉴来源」。
