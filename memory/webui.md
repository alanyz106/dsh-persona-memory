# WebUI 记忆管理页

## 结构

- Host：`lib/admin.ts` 用 `webServer` 注册 `/api/persona-memory/*` 路由，**loopback-only 防护**（同 dsh-ssh 围栏；隧道场景靠 `adminAllowedHosts` / `adminAllowedHostsFile` 按请求解析当前权威）。
- Client：源码 `client/src/main.ts`（TS，纯 `React.createElement`），由 `scripts/build-client.mjs`（esbuild，external react）构建成预构建 bundle `client/client.js`（`window.__ModuleLoader__.load` 格式，经 `dsh.client` + `exports["./client"]` 声明加载）。
- **bundle 无 `harness.handle`**，Client↔Host 一律同源 `fetch` 调路由。
- 页面注册到 `settings.section` slot（id=persona-memory，order=25，label=记忆管理）。

## 卡片

常驻指令 / 记忆文件 / 项目记忆 / 检索索引 / 本地备份 / 插件配置。

- **检索索引卡 = 纯状态**（FTS5 / 向量大小、重建按钮），**不含任何配置项**——向量配置统一在插件配置卡。
- **插件配置卡**按 `CFG_SCHEMA` schema 驱动渲染（bool→checkbox、number→数字框、select→按钮组、string→输入框）。`embeddingModel` 特殊渲染：输入框 + 缓存检测 + 已下载模型按钮组。保存写回当前 profile 的 `cordis.patch.yml` 中 persona-memory 段（`adminProfile` 指定 profile 名，默认 web）。
- **项目记忆卡**：每个项目显示根路径 → 常驻区（**独立折叠三角**，默认收起；带预算条、可整段编辑）→ 索引行（每行 `@memory/x.md — 描述` + 编辑 / 删除）→ 未索引文件（孤儿）→ 新建记忆文件 / 迁移旧 AGENTS.md → 手动登记项目路径。「编辑」打开的是**该索引指向文件的全文**，不是索引行本身；「删除」= 删索引行 + 文件移入 `memory/.trash/`。
- **迁移按钮的启用条件**：`canMigrate = AGENTS.md 存在 && 索引条目数 == 0`。已有索引即视为「已迁移」，按钮禁用并给出原因提示——迁移只处理纯散文文档，对已迁移文件重跑会用「计划里的几条」替换整个索引，把原有主题文件全变成孤儿（0.3.2 修）。
- **登记项目**：只写 `project-registry.json`，不创建文件；用于补登记还没在会话里用过的仓库（项目记忆散在各仓库，没有统一目录可扫）。

## 备份

- 目录 `$DSH_HOME/memory-backup/latest/`，只保留最新快照。
- 全局 4 文件平铺：MEMORY.md / USER.md / failures.md / STANDING.md。
- 项目记忆按注册表快照到 `latest/projects/<name>/{AGENTS.md,memory/**}`（跳过 `.trash` 与 dot 条目）。
- **自动保护**（`startAutoProtect`，index.ts 启动，`ctx.timer` 每分钟 tick）：按 `autoBackupMin`（默认 60，0=关）覆盖备份 + Pi 丢失检测（`autoSwitchOnPiLoss`）。

## 改动流程

Client 源码改后必须 `npm run build:client` 重建 + 重装 + 重启 web 才生效（预构建产物按包分发）。client 只依赖 react + 浏览器 fetch，**不 import 任何 `@deepseek-ai` client 包运行时值**。
