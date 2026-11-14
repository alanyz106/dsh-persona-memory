# 工具与命令

| 工具/命令 | 说明 | 详情 |
|---|---|---|
| `memory` | 全局记忆：`read`（返回全文）/ `add` / `update` / `delete` / `rewrite`，`which` 选 `memory` / `user` | [disk-format.md](disk-format.md) |
| `memory_search` | 全局记忆检索：`query` + 可选 `which`（`memory`/`user`/`all`）；FTS5 起底，开 `vectorEnabled` 后混合检索。注入只带最近部分，更早的条目用它查 | [vector-search.md](vector-search.md) |
| `project_memory` | 项目记忆：`list` / `read` / `write` / `append` / `update` / `delete` / `search` / `add_resident` / `remove_resident` / `migrate` / `guide`；作用域为当前项目 | [project-memory.md](project-memory.md) |
| `/standing` | 列出 / `add <文本>` / `remove <n>` / `clear` 常驻指令；模型无写入口 | [standing.md](standing.md) |

## 三区边界

| 内容 | 写到哪 |
|---|---|
| 用户偏好、跨项目事实、通用环境怪癖、换仓库仍会重犯的教训 | 全局 `memory`（MEMORY.md / USER.md） |
| 只在这个仓库成立的约定、架构、坑、SOP | 项目记忆（`AGENTS.md` + `memory/`） |
| 用户亲笔、始终生效、高于模型默认行为 | `/standing`（STANDING.md） |

三条判据：

1. **换个仓库还成立 → 全局；只在这里成立 → 项目。**
2. **「不做就会错」→ 常驻区；「做的时候查一下」→ 主题文件。**
3. 拿不准就先写主题文件——从检索区升级到常驻区的成本，远低于反过来。
