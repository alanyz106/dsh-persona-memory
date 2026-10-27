# 迭代与上线 SOP（固定流程，每次照做）

## 阶段一：UI / 逻辑快速迭代期（免重启）

用动态 Cordis 插件（`cordis_define` kind:new 一次 + kind:existing 追加迭代），双勾授权后 update 免批准，改完秒生效。定稿后才走阶段二。

## 阶段二：固化进 bundle（正式发布，需要重启 web）

0. **⚠️ 先取动态插件最终版源码作为临时对照物**：用 `cordis_inspect_self(pluginId, packageId)` 取最终 Package 的完整 host + client 源码，**临时保存到 `dev/<功能名>-final.js`**。动态插件只在运行进程内存里，undefine 后永久丢失。
   - **对照物用完即删**：固化完成、逐卡验证一致后删除并 `git rm`。不要长期保留中间存档——git 才是唯一真源；过时存档会误导后续固化（历史教训：v10 三卡存档让固化把「配置移到插件配置卡」的 v27 定稿做反了）。
1. **改代码**：`index.ts` / `lib/*.ts` / `client/src/main.ts`，改完先 `npm run build`。
   - **Client UI 渲染层逐字复制**动态版，只替换 api 调用层和包壳。
   - **Host 逻辑层必须改写**：动态在受限沙箱（`ctx.get('fs')`、无 node:fs/process），bundle 有完整 node:fs；动态 `harness.handle` → bundle `webServer` 路由。
   - **固化后逐卡片对照存档源码**，不许凭记忆重写、不许删减 UI 区块。
2. **升版本**：`package.json` version 递增（每次上线必须升，否则 pnpm store 判定"无变化"可能不刷新副本）。
3. **同步文档**：AGENTS.md 常驻区 / 索引 + README.md 功能表 / 配置表。
4. **验证**：`npm run typecheck` + `node test/smoke.mjs`（226 项，exit=0）+ `node --check` dist 全部产物 + 模块级端到端测试（备份 / 恢复 / patch 写回用临时目录）。
5. **重装**（⚠️ 必做，pnpm 有 store 缓存）：
   ```bash
   dsh plugin --profile web remove dsh-persona-memory
   dsh plugin --profile web add file:<本仓库路径>
   ```
   验证 `<profile>/node_modules/dsh-persona-memory/package.json` version 与仓库一致。
6. **重启 web**：杀掉 `dsh web` 进程 → 同参数重启 → 刷新 GUI。
7. **验证页面**：设置页「记忆管理」六张卡逐项核对。
8. **git 提交**：`git add -A && git commit`（message 带版本号）→ `git push origin main`。

## git 工作流

- **永远只在 `main` 分支工作**（已删除 dev 分支——dev 分支与 `dev/` 中间存档一样只会误导）。
- 每次固化完成后提交 + 推送，仓库任何时候 `git status` 应为 clean。
