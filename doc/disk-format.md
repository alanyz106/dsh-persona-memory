# 磁盘格式（与 pi-hermes-memory 一致）

```markdown
<条目文本> <!-- created=2026-08-13, last=2026-08-13 -->
§
<另一条目文本> <!-- created=2026-08-13, last=2026-08-13 -->
```

- 条目以 `\n§\n` 分隔，每条是单行文本 + 行尾 `<!-- created=YYYY-MM-DD, last=YYYY-MM-DD -->` 注释。
- 无注释的旧条目照常解析（日期默认为今天）。
- 写入采用原子写（临时文件 + rename），并按文件串行化，避免并发工具调用互相覆盖。
- 字节级兼容：文件无尾随换行，`charCount` 含分隔符。
- 常驻指令 STANDING.md 是例外：每行一条，无分隔符、无元数据。

## 涉及的文件

| 文件 | 位置 | 说明 |
|---|---|---|
| `MEMORY.md` | `<dir>` | 事实/偏好/约定/环境 |
| `USER.md` | `<dir>` | 用户画像 |
| `STANDING.md` | `<dir>` | 常驻指令（仅用户可写） |
| `project-registry.json` | `<dir>` | 已登记项目的 `name → root` |
| `AGENTS.md` | 各仓库根 | 常驻区 + `@memory/*.md` 索引行 |
| `memory/*.md` | 各仓库根下 | 项目主题文件；删除的文件进 `memory/.trash/` |

## 与 Pi 共用时的注意点

- **避免同时写**：两边都是原子写，但 Pi 有跨进程锁，DSH 侧用**写前指纹预检**兜底——检测到外部改动就不覆盖并提示冲突。极端并发下仍可能互相感知不到，**不同时运行最安全**。
- 覆盖的全局文件：`MEMORY.md` / `USER.md` / `STANDING.md`。
- 两边扫描标准一致，hermes 写入的内容 DSH 直接可读，反之亦然。
- **项目记忆不与 Pi 共用**：仓库内的 `AGENTS.md` + `memory/` 是本插件独有的，Pi 的 `projects-memory/` 目录不再读取也不再写入。
