# 配置项（均可选）

默认值 = 插件出厂默认。每项都可在 profile 的 `cordis.patch.yml` 的 `persona-memory` 段或 WebUI「插件配置」卡里改。

## 基础

| 键 | 默认 | 含义 |
|---|---|---|
| `dir` | 见下 | 记忆文件目录；显式设置优先 |
| `memoryCharLimit` | `5000` | MEMORY.md 注入上下文的最大字符数 |
| `userCharLimit` | `5000` | USER.md 注入上下文的最大字符数 |
| `enableSecretScanning` | `true` | 每次写入是否过内容扫描 |
| `inject` | `true` | 是否注册系统提示词注入段落 |
| `injectHumanOnly` | `true` | 仅人类主会话注入；子代理/派生会话不注入（继承父会话上下文） |
| `sectionOrder` | `55` | 注入段落在系统提示词中的顺序 |
| `usageNudgeThreshold` | `0.9` | 达到该用量比例时提醒合并 |

`dir` 解析顺序：① 显式 `config.dir` → ② `~/.pi/agent/pi-hermes-memory`（若已存在 `MEMORY.md`，即与 Pi 共用）→ ③ `$DSH_HOME/memory`（默认 `~/.dsh/memory`）。

## 检索

| 键 | 默认 | 含义 |
|---|---|---|
| `searchMaxResults` | `10` | `memory_search` 单次最多返回条数 |
| `memoryFtsEnabled` | `true` | 启用 SQLite FTS5 记忆镜像 |
| `vectorEnabled` | `false` | 启用语义向量搜索（FTS5 + 向量 RRF 混合检索） |
| `vectorIndexDir` | `$DSH_HOME/memory` | 向量索引目录（DSH 侧，绝不写入 Pi 共享记忆目录） |
| `embeddingProvider` | `remote` | `remote`（OpenAI 兼容 `/embeddings`）或 `local`（自带 transformers.js） |
| `embeddingBaseUrl` | `''` | 远程 embedding API 基址 |
| `embeddingApiKey` | `''` | 远程 API Key；不填则读 `DSH_EMBEDDING_API_KEY` |
| `embeddingModel` | `text-embedding-3-small` | embedding 模型名（local 默认 `Xenova/all-MiniLM-L6-v2`） |
| `embeddingCacheDir` | `$DSH_HOME/models` | local 模型缓存目录 |
| `embeddingRemoteHost` | `https://huggingface.co` | local 模型下载源；大陆可用 `https://hf-mirror.com` |

## 学习与纠正

| 键 | 默认 | 含义 |
|---|---|---|
| `learnEnabled` | `false` | 后台自动学习；默认关闭，避免模型推断的事实未经确认就写入长期记忆 |
| `learnHumanOnly` | `true` | 仅人类主会话学习 |
| `learnIntervalTurns` | `10` | 每 N 轮触发一次复习 |
| `learnRecentTurns` | `2` | 每次复习取最近多少轮 |
| `learnMaxChars` | `6000` | 复习用的对话/记忆摘要最大字符数 |
| `learnTimeoutMs` | `120000` | 学习 LLM 调用超时 |
| `learnProjectContext` | `true` | 把项目记忆摘要一并给学习模型做「已存在则跳过」判断 |
| `learnProjectContextCharLimit` | `1500` | 上述摘要的字符预算 |
| `autoConsolidate` | `true` | 超限时自动 LLM 合并（严格更小才提交） |
| `consolidateStaleDays` | `30` | 合并时判定"陈旧可删"的天数 |
| `consolidateTimeoutMs` | `120000` | 合并 LLM 调用超时 |

## 常驻指令

| 键 | 默认 | 含义 |
|---|---|---|
| `standingEnabled` | `true` | 启用常驻指令（STANDING.md + `/standing`） |
| `standingCharLimit` | `2000` | STANDING.md 注入预算（硬上限） |
| `standingMaxEntries` | `20` | STANDING.md 最大条数（硬上限） |

## 项目记忆

| 键 | 默认 | 含义 |
|---|---|---|
| `projectEnabled` | `true` | 启用项目级记忆（`project_memory` 工具 + 项目段注入） |
| `projectFileCharLimit` | `20000` | 单个 `memory/<主题>.md` 的字符上限 |
| `projectResidentCharLimit` | `6000` | `AGENTS.md` 常驻区字符预算 |
| `projectIndexCharLimit` | `4000` | `AGENTS.md` 索引区字符预算 |
| `projectAutoMigrate` | `true` | 首次写入遇到散文 `AGENTS.md` 时是否允许 LLM 拆分 |
| `projectMigrateTimeoutMs` | `1200000` | 一次迁移规划调用超时（默认 20 分钟） |
| `projectBootstrapHint` | `true` | 无记忆的 git 仓库里注入「怎么建项目记忆」引导 |

## 管理页与备份

| 键 | 默认 | 含义 |
|---|---|---|
| `adminProfile` | `web` | 记忆管理页配置写回的目标 profile |
| `adminAllowedHosts` | `[]` | 管理接口接受的额外 Host（隧道/反代）；仍要求连接来自本机回环 |
| `adminAllowedHostsFile` | `/var/lib/cloudflared/dsh-url.txt` | 当前公网 URL 文件，逐请求重读 |
| `autoBackupMin` | `1440` | 自动备份间隔（分钟），`0` 关闭；默认每天一次 |
| `backupKeep` | `10` | 历史快照保留份数；`0` = 只保留 `latest/` |
| `autoSwitchOnPiLoss` | `true` | Pi 共享记忆丢失时自动切到本地并从最新备份恢复 |
| `fileLogEnabled` | `true` | 把插件日志写到 `$DSH_HOME/logs/persona-memory.log` |
| `fileLogPath` | `''` | 日志路径；留空用默认 |
