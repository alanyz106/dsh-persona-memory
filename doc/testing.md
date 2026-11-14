# 测试

```bash
npm run typecheck                       # tsc host + client
npm run build                           # dist/ + client/client.js
node test/smoke.mjs                     # 主测试：443 项
node test/client-ui.mjs                 # 浏览器 bundle 契约测试
node test/admin-fence.mjs               # 管理接口 loopback 围栏
```

## 结构

`test/smoke.mjs` 只是运行器，按文件名顺序加载 `test/suites/*.mjs`。所有套件共享 `test/harness.mjs` 里的：

- 一个临时目录（跑完删除，**绝不碰真实的 `~/.pi` / `~/.dsh` 文件**）；
- 一个 pass/fail 计数器；
- `shared` 对象——少数跨套件复用的夹具（`store` / `projRoot` / `backupMemDir`）。

| 套件 | 覆盖 |
|---|---|
| `01-store` | 全局存储读写、search、rewrite 与 § 分隔符回归 |
| `02-scanner-standing` | 内容扫描、事实解析、常驻指令、手动整理提示词 |
| `04-project-memory` | 项目根探测、路径安全闸门、索引解析、主题文件 IO、预算、注册表、目录扫描 |
| `05-migration-planner` | 迁移计划解析与全部校验闸门、提示词（指南 + 宽主题 few-shot） |
| `07-fts-cjk` | FTS5 镜像、OR 查询、注入安全、CJK bigram 检索、降级 |
| `08-tools-guide` | `memory` / `project_memory` 工具面、写法指南两种尺寸 |
| `09-store-semantics` | 并发、溢出拒绝、字节兼容序列化、注入围栏 |
| `10-retrieval-sessions` | 向量索引增量同步、RRF、`memory_search` 路由、派生会话排除 |
| `11-backup` | 备份镜像语义、历史快照、保留份数、出厂默认值 |
| `12-admin-routes` | 管理路由族、按名恢复、拒绝原因、单飞迁移进度、按天数清理 |
| `13-migration-e2e` | `migrateAgents` 全链路、超时传递、各类拒绝路径 |
| `14-plugin-lifecycle` | 热重载不重复注册路由、项目段注入与 bootstrap 提示 |
| `15-learning` | transcript 来源标注、项目摘要预算、学习提示词、轮次裁剪 |
| `17-project-archive` | zip 编解码（CRC / 上限 / 解压炸弹）、导出→导入往返、恶意压缩包拒绝、.bak 与 .trash 保护 |

## 为什么 CI 仍只跑一个入口

`.github/workflows/release.yml` 里是 `node test/smoke.mjs`；拆分成套件后入口不变，发布流程无需改动。
