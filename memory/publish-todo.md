# TODO：走通 npm 发布链路

状态：**未开始**（用户 2026-10-27 明确"放到以后再说"）。

## 目标

其他机器上一条命令装到改过的版本：

```bash
dsh plugin --profile web add @alanyz106/dsh-persona-memory
```

## 现状（2026-10-27 核对）

| 项 | 状态 |
|---|---|
| npm 包 `@alanyz106/dsh-persona-memory` | **不存在**（`npm view` 返回 404，从未发布） |
| 本地未 push 的提交 | 2 个（0.3.1 UI 修复、0.3.2 备份历史快照） |
| 当前安装方式 | `file:/root/dsh-persona-memory`（本地路径，与 npm 包互不相干） |
| git tag 0.3.x | 无（v0.2.4 是最后一个） |
| npm Trusted Publisher | 未配置 |

## 待办

1. `git push origin main`（会同时推送 `.github/workflows/publish.yml`，注意 token 需 `workflow` scope；本地 gh 已授权）
2. npm 包设置页配 Trusted Publisher：owner `alanyz106`、repo `dsh-persona-memory`、workflow `publish.yml`
3. 确认 `package.json` 的 `publishConfig.access = public`（scoped 包必须）——已配置
4. push 后看 Actions：build → 249 项 smoke → `npm view` 版本比对 → 不同才 `npm publish --provenance` + 打 tag
5. 在另一台机器验证：装 dsh → `dsh plugin --profile web add @alanyz106/dsh-persona-memory`

## 关键前提（别踩）

- **不能裸 `npm install`**：dsh 插件的 `@deepseek-ai/*` 是 peerDependencies，必须由宿主提供。裸装会形成双物理副本 → `TOOL_RUNTIME_SCHEDULER` 互不认 → 所有工具调用崩（见 `memory/pitfalls.md`）。必须走 `dsh plugin add`。
- **版本号是发布开关**：CI 只有在 `package.json` 版本 ≠ npm 已发布版本时才 publish，否则只跑测试。
- **改包名必须同步 `cordis.patch.yml` 的 `name`**，否则 bundle 激活失败（曾经导致 `dsh` 完全打不开，教训见全局记忆）。

## 版本号可自由调整（未发布前）

0.3.0 从未发布、0.3.x 无 tag，所以本地把 `version` 改回 `0.3.0` 是无损的：
没有远端状态需要对齐，也没有已发布版本号需要避开。

一旦某一版真正 `npm publish` 成功，那个版本号就**永久冻结**（npm 不允许重发同一版本），
之后只能往上加。
