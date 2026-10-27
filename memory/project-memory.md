# 项目记忆（0.3.0 起的模型）

## 数据模型

项目 = **git 主仓库根**（`lib/projects.ts` 的 `findGitRepoRoot`，linked worktree 共享）；非 git 目录退化为会话 cwd；家目录 / 文件系统根不算项目。

```
<项目根>/
├── AGENTS.md   ← 常驻区（原样注入）+ 末尾 @memory/*.md 索引行
└── memory/     ← 一主题一文件，按需 read；.trash/ 存删除的文件
```

- **索引行识别是行级的**：`@memory/<path>.md — 描述`（允许 `-`/`*` 前缀、`—`/`--`/`:` 分隔符）。文件里其余内容全部归入常驻区，原样保留。
- 无常驻内容时文件只有 `@` 行，这是规范形态。
- `AGENTS.md` 由宿主 `@deepseek-ai/dsh-agent-instructions` 整份注入，所以常驻区天然每次请求生效；插件不再重复注入条目，只注入"索引是懒加载、需要时读"的约定。
- 常驻区预算 `projectResidentCharLimit`（3000）、索引预算 `projectIndexCharLimit`（4000）、单文件上限 `projectFileCharLimit`（20000）。超预算拒绝写入，不静默裁剪。

## 工具

`project_memory`，作用域固定为当前会话项目（无 `project` 参数，避免任意路径写）：

| action | 行为 |
|---|---|
| `list` | 索引 + 孤儿文件 + 用量 |
| `read` | 读一个主题文件 |
| `write` | 新建 / 覆盖并维护索引行 |
| `append` | 追加小节 |
| `delete` | 删索引行 + 文件移 `memory/.trash/` |
| `search` | 跨主题文件子串 AND |
| `add_resident` / `remove_resident` | 编辑常驻区 |
| `migrate` | 把 prose AGENTS.md 拆成常驻 + 索引 |

## 路径安全

`safeMemoryRel` 是唯一入口：必须 `memory/**.md`、无 `..`、无绝对路径、无 dotfile、resolve 后仍在 `memory/` 内（含符号链接逃逸检查）。工具参数、管理页 body、迁移器产出全部过它。

## 注册表

项目记忆散落在各仓库里，没有统一目录可扫，所以 `<memoryDir>/project-registry.json` 记住见过的项目根（name → root，含 lastSeen）。**管理页的每个写路由都只接受注册表内的项目名**，不接受浏览器传来的路径——否则 loopback 页面就成了任意文件读写入口。

## 迁移

已有 prose AGENTS.md 由辅助 LLM 规划拆分：常驻区只保留操作性硬约束（构建 / 测试命令、禁改清单、部署约束、必守规范），其余按主题拆进 `memory/*.md`。硬校验：**原文每个标题必须能在常驻区或某个主题文件里找到**，否则迁移失败且不动文件；原文另存 `AGENTS.md.bak-<时间戳>`。
