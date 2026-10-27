# 项目事实

DSH 的持久化长期人格记忆插件。TypeScript 源码，tsc + esbuild 构建。

## 用途与工具面

- `memory` 工具：`read` / `add` / `update` / `delete` / `rewrite`，`which` 选 `memory` / `user` / `failure`。
- `memory_search` 工具：FTS5 + 向量 hybrid 检索，无语义索引时降级 FTS5 / 子串。
- `project_memory` 工具（0.3.0 起）：项目级记忆，见 `memory/project-memory.md`。
- 每请求把记忆注入 system prompt（默认 order 55），写入带内容扫描（秘密 / 提示注入拦截）。

## 注入顺序

| order | 段 | 内容 |
|---|---|---|
| 50 | `memory:standing` | STANDING.md 常驻指令 |
| 52 | `memory:failures` | 最近失败记忆 |
| 53 | `memory:project` | 项目记忆索引与加载约定（条目本身由宿主 agent-instructions 注入 AGENTS.md） |
| 55 | `memory:profile` | 全局 MEMORY.md + USER.md |

## 模块地图

- `index.ts`：插件契约（`apply` / `inject` / `name`），组装所有模块。
- `lib/memory-store.ts`：磁盘格式（`\n§\n` 分隔 + 行尾元数据注释）。
- `lib/secret-scanner.ts`：内容扫描器。
- `lib/memory-tool.ts` / `lib/memory-search-tool.ts`：两个全局工具。
- `lib/prompt.ts`：`<memory-context>` 围栏渲染。
- `lib/learning.ts` / `lib/consolidate.ts` / `lib/llm-helper.ts` / `lib/correction.ts`：自动能力。
- `lib/sessions.ts`：人类主会话 vs 派生会话分级。
- `lib/fts.ts` / `lib/cjk-tokenizer.ts`：FTS5 镜像与中文 bigram。
- `lib/vector-index.ts` / `lib/embedding.ts`：向量镜像与 embedding provider。
- `lib/standing.ts` / `lib/standing-command.ts`：常驻指令与 `/standing` 命令。
- `lib/failures.ts`：失败记忆。
- `lib/projects.ts`：git 仓库根探测。
- `lib/project-memory.ts`：AGENTS.md 索引解析/渲染、memory/ 文件读写、路径安全闸门、跨文件检索。
- `lib/project-registry.ts`：`<dir>/project-registry.json`（项目根散落在各仓库，靠它列出）。
- `lib/project-migrate.ts`：辅助 LLM 把 prose AGENTS.md 拆成常驻 + 主题文件（含标题保全校验）。
- `lib/project-memory-tool.ts`：`project_memory` 工具。
- `lib/admin.ts`（Host 路由）+ `client/src/main.ts`（WebUI 源码）。
- `test/smoke.mjs`：冒烟测试，import `dist/` 产物。

## 构建产物

- `dist/`（tsc）+ `client/client.js`（esbuild，`window.__ModuleLoader__.load` 格式），均 gitignore，安装 / 发布前先 `npm run build`。
