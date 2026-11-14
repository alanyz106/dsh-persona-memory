# 自动能力：学习、合并、清理

这些能力都用**会话自身的 LLM 路由**（`ctx.llm.stream`），不需要额外配置 API key；路由解析优先复用最近一次会话请求，其次继承宿主的 `agentDefaultModel`。

## 后台学习

每 `learnIntervalTurns`（默认 10）轮复习近期对话，提取**跨项目**持久事实存入全局记忆。

- **默认关闭**（`learnEnabled: false`）：模型推断出的事实未经确认就进长期记忆，风险高于收益；需要时在配置里显式打开。
- **项目知识不写全局**：项目专属内容由主模型的 `project_memory` 维护。学习模型会拿到当前项目记忆摘要做去重判断。
- **transcript 标注来源**：宿主注入的 AGENTS.md 标记为 `PROJECT-INSTRUCTIONS ... do not re-extract`，与真实用户发言区分；`runtime-context` / `time-context` / `skill-catalog` 一律丢弃。
- 只取最近 `learnRecentTurns` 轮、上限 `learnMaxChars` 字符，超预算整轮丢弃（不切半轮）。

## 教训写到哪里

插件不设独立的失败记忆文件，按归属分三处：

| 内容 | 写到哪 |
|---|---|
| 换个仓库仍会重犯的教训、机器级工具怪癖、全局约定 | 全局 `memory` 工具（`MEMORY.md`） |
| 用户亲笔、始终生效的硬规则 | `/standing`（`STANDING.md`，模型无写入口） |
| 只在本仓库成立的踩坑（构建、部署、架构、本代码库的 bug） | 该仓库的项目记忆：`memory/pitfalls.md` 主题文件，必要时升级为 `AGENTS.md` 常驻规则 |

边界会出现在 `memory` / `project_memory` 两个工具的说明和项目记忆指南里，避免模型把仓库专属的坑写进全局记忆。

## 记忆整理

- 管理页对 `MEMORY.md` / `USER.md` 的每条记忆显示 `创建` / `最近引用` 日期，可据此判断哪条长期没被引用。
- 每个记忆文件下方有「清理旧条目」：输入天数 → 预览待删条数 → 二次确认后按 `created` 日期批量删除；删除前自动把整个文件快照到 `<dir>/.trash/`，可恢复。没有 `created` 标记的旧条目按“今天”处理，不会被误删。
- 超过字符上限时用 LLM 合并精简（> `consolidateStaleDays` 天无引用可删、偏好优先保留）。
- **只有合并结果严格更小、可解析且过扫描才提交**，失败绝不损坏记忆。

## 会话分级

子代理 / 派生会话（subagent、workflow 子会话、AgentTeams 成员）**不注入记忆、不参与后台学习**（`injectHumanOnly` / `learnHumanOnly`，默认全开）；人类主会话行为不变。