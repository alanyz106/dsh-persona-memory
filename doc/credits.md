# 借鉴来源（明确声明）

本插件大量借鉴 [pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory)（MIT，作者 chandra447，其本身移植自 [hermes-agent](https://github.com/anthropics/hermes-agent)）。按借鉴程度分四档。

## 1. 代码级移植（近逐行，MIT 保留声明）

| 文件 | 来源 | 移植内容 |
|---|---|---|
| `lib/secret-scanner.ts` | hermes `content-scanner.ts` | 11 条提示注入/外泄威胁模式 + 19 条凭据模式 + 不可见 Unicode 字符集 |
| `lib/standing.ts`（核心） | hermes `standing-instructions.ts` | 容错解析（`#` 注释/`-`/`*` 列表符/去重）、硬预算（20 条/2000 字符）、`<standing-instructions>` 渲染块（超预算在块内声明遗漏）、来源约束（仅用户可写） |

## 2. 格式级兼容（字节兼容，实现重写）

| 文件 | 来源 | 兼容内容 |
|---|---|---|
| `lib/memory-store.ts`（磁盘格式） | hermes `MemoryStore` | `\n§\n` 分隔符、`encodeEntry`/`decodeEntry` 正则（兼容 `project64` 旧字段）、`YYYY-MM-DD` 日期 |
| （已弃用）`lib/projects.ts` 的 Pi 项目根解析 | hermes `project.ts` / `paths.ts` | 0.0.1 起只保留「git 仓库根身份（worktree 共享）」的探测思路，`projects-memory/` 路径与迁移桥已删除 |

## 3. 概念级移植（思路照搬，代码全新）

| 功能 | 来源概念 | 本插件实现 |
|---|---|---|
| 后台学习 | hermes 每 10 轮复习 | DSH `session/event` 钩子 + `ctx.llm.stream` + 自写提示词 |
| 自动合并 | hermes `auto-consolidate.ts` | 超限触发、合并规则、**严格更小才提交**安全护栏 |
| 记忆老化 | hermes Memory Aging | `created/last` 日期驱动合并决策 |

## 4. DSH 原生（未借鉴 hermes，基于 DSH API 构建）

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

## 许可

MIT。
