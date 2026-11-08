# 自动能力：学习、纠正、失败记忆、合并

这些能力都用**会话自身的 LLM 路由**（`ctx.llm.stream`），不需要额外配置 API key；路由解析优先复用最近一次会话请求，其次继承宿主的 `agentDefaultModel`。

## 后台学习

每 `learnIntervalTurns`（默认 10）轮复习近期对话，提取**跨项目**持久事实存入全局记忆。

- **默认关闭**（`learnEnabled: false`）：模型推断出的事实未经确认就进长期记忆，风险高于收益；需要时在配置里显式打开。
- **项目知识不写全局**：项目专属内容由主模型的 `project_memory` 维护。学习模型会拿到当前项目记忆摘要做去重判断。
- **transcript 标注来源**：宿主注入的 AGENTS.md 标记为 `PROJECT-INSTRUCTIONS ... do not re-extract`，与真实用户发言区分；`runtime-context` / `time-context` / `skill-catalog` 一律丢弃。
- 只取最近 `learnRecentTurns` 轮、上限 `learnMaxChars` 字符，超预算整轮丢弃（不切半轮）。

## 纠正检测

- **`/correct` 命令**（显式纠正，立即落盘、不限频）：输入 `/co` 后点选补全项或按 Tab 会把 `/correct ` 填入输入框等你补内容。
- **对话内模式检测**：强/弱/负向三组模式 + 指令词，仅直接人工消息，`correctionRateLimitTurns` 轮限频。
- **不再消费官方 `/feedback` 事件**：那是 harness 的会话反馈命令（遥测用途），把产品吐槽误存成模型纠正属语义错位。

## 失败记忆

`failures.md` 结构化记录：

```
[category] 内容 — Failed: 原因 — Corrected to: 修正
```

最近 `failureMaxAgeDays` 天、最多 `failureMaxEntries` 条自动注入上下文（`memory:failures` 段），防止重蹈覆辙。`update` 走 `mergeFailureUpdate`，只改指定的字段，不会把 `Failed:` / `Corrected to:` 丢掉；`correctedTo: ''` 才是显式清除。

## 自动合并

记忆超限时用 LLM 合并精简（> `consolidateStaleDays` 天无引用可删、偏好/纠正优先保留）。

**只有结果严格更小、可解析且过扫描才提交**，失败绝不损坏记忆。

## 会话分级

子代理 / 派生会话（subagent、workflow 子会话、AgentTeams 成员）**不注入记忆、不参与后台学习、不产生纠正条目**（`injectHumanOnly` / `learnHumanOnly` / `correctionHumanOnly`，默认全开）；人类主会话行为不变。
