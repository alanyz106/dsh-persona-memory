# 常驻指令（STANDING.md）

与 pi-hermes-memory 一致：**每行一条**，无分隔符、无元数据；容忍空行、`#` 注释和行首 `-` / `*` 列表符，手改时仍是普通 Markdown。

## 注入

注入块用 `<standing-instructions>` 围栏，声明"用户亲写的规则、始终生效、高于默认行为"。超预算时在块**内部**声明被省略的条数，绝不静默丢弃：

```
[!] 1 further standing instruction could not be shown: STANDING.md exceeds the
60-character injection budget. Trim it with /standing so every rule stays active.
```

## 来源约束

**只有 `/standing` 命令或用户直接编辑文件能写入**——模型没有写入口。后台学习、合并、纠正检测都不碰它。这是刻意的：能写常驻指令的模型等于能给自己加规则。

## 命令

| 命令 | 说明 |
|---|---|
| `/standing` | 列出当前常驻指令 |
| `/standing add <文本>` | 钉住一条 |
| `/standing remove <n>` | 按 1 起编号移除 |
| `/standing clear` | 清空 |

## 与项目记忆的边界

`STANDING.md` 是**用户对所有项目**的硬指令；`AGENTS.md` 常驻区是**某个仓库**的约定。判据：换仓库还成立且是"用户亲口要求"的 → `STANDING.md`；只在这个仓库成立的工程约定 → `AGENTS.md`。
