# AGENTS.md — dsh-persona-memory 开发约定

本文件给任何在此仓库工作的 agent 在动代码前必读。具体的项目记忆在文件末尾的 `@memory/` 索引行指向的文件里，按需读取。

## ⚠️ 首要规范：宿主包必须 peerDependencies（违反会炸掉全部工具）

- `@deepseek-ai/*` 宿主包（`dsh-tools`、`dsh-llm`、`dsh-home-paths` 等）**只允许出现在 `peerDependencies`**，**绝不写进 `dependencies`**。
- **为什么**：`dsh plugin add`（=pnpm）会把 `dependencies` 真装进 `<profile>/node_modules`，与宿主 dsh 安装目录形成**双物理副本**；`dsh-tools` 的 `TOOL_RUNTIME_SCHEDULER` 是普通 `Symbol()`（非 `Symbol.for()`），双副本互不认 → 执行循环读不到调度器 → **所有工具调用崩** `Cannot read properties of undefined (reading 'prepare')`。
- **为什么 peer 就够了**：兜底目录 `$DSH_HOME/profiles/node_modules`（每次启动自动维护）保证 peer 声明下解析自动回落宿主副本——**peer 是唯一必需的声明**。
- 若安装后 `<profile>/node_modules/@deepseek-ai/` 出现真副本 → 直接删除副本即可，兜底会接管解析。

## 硬性流程

- **改代码后先构建**：`npm run build`（tsc → `dist/` + esbuild → `client/client.js`）。`dist/` 与 `client/client.js` 是 gitignore 的产物，不要手改。
- **提交前必须全绿**：`npm run typecheck`（host + client 双 tsconfig 零错误）+ `node test/smoke.mjs`（exit=0）。
- **重装必须 remove 再 add**（pnpm store 有缓存，只 add 可能装旧字节）；改 client 后必须重建 + 重装 + 重启 web 才生效。
- **只在 `main` 分支工作**，提交信息带版本号；仓库任何时候 `git status` 应为 clean。
- **测试严禁删真实数据目录**（`$DSH_HOME/memory-backup/latest/` 等），一律用临时目录。

@memory/overview.md — 插件定位、模块地图、注入顺序、工具面
@memory/architecture.md — 自动学习、合并、FTS5、向量、常驻指令、失败记忆的实现细节
@memory/project-memory.md — 项目记忆：AGENTS.md 常驻区 + @memory/ 索引 + memory/ 主题文件
@memory/webui.md — 记忆管理页：卡片结构、路由族、配置写回
@memory/release-sop.md — 两阶段迭代与上线 SOP、git 工作流
@memory/pitfalls.md — 已知坑：pnpm 缓存、client 重建、版本兼容、备份数据