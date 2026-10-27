# 常见坑与版本兼容

## 构建与安装

- pnpm `add file:` 复用 store 缓存 → 装到旧版本 / 旧字节（现象：version 没变、`dist/lib/admin.js` 长度不对）→ **先 remove 再 add**，别只 add。
- 改 `client/src` 后必须 `npm run build:client` 重建 + 重装 + 重启 web 才生效（预构建产物按包分发）。
- **bundle 无 `harness.handle`**：Client↔Host 走 `webServer` 路由 + fetch。

## 项目记忆

- `AGENTS.md` 是宿主 `@deepseek-ai/dsh-agent-instructions` 注入的——**写坏它 = 模型立刻丢失那部分规则**。迁移前插件会先存 `AGENTS.md.bak-<时间戳>`，标题保全校验不过就整份放弃。
- 三个预算超限都**拒绝写入**（常驻区 3000 / 索引 4000 / 单文件 20000），不静默裁剪。
- 管理页的写路由只接受注册表内的项目名，不接受浏览器传来的路径——别为了方便加"按路径操作"的口子。
- `memory/.trash/` 是删除文件的回收站，备份会跳过它。

## WebUI 缓存

- 插件 client bundle 由宿主 `dsh-client-modules` 以 `cache-control: public, max-age=31536000, immutable` 提供，正常刷新（F5）可能仍命中旧字节。常见症状：**页面是旧界面（旧文案、`[object Object]`、`undefined 字符`），但 `status` 路由返回的是新数据结构**——即"新后端 + 旧 client"。
- 处理：强制重新加载（Ctrl+Shift+R / 关掉标签页重开）。不是插件问题，别去重装或改代码。
- 判断依据：`grep -c projectResident ~/.dsh/profiles/web/node_modules/dsh-persona-memory/client/client.js` 命中说明磁盘上是新版；再对 `status` 路由看返回字段名是否为新结构。

## 数据安全

- 备份目录 `$DSH_HOME/memory-backup/latest/` 是**真实数据**，测试 / 清理时先确认，删了要立即 `backupAll` 重建。
- 测试一律用临时目录，**严禁删真实数据目录**。

## 版本兼容

- peer 范围 `^0.1.0-rc.6 || ^0.2.0-rc.1`（覆盖 0.1.x / 0.2.x）。
- 0.2.x 的 dsh 安装与启动时用 `evaluatePluginCompatibility` 校验 `@deepseek-ai/dsh-*` peer（`includePrerelease: true`）——范围不含运行版本会拒绝安装、并跳过该 bundle 层。只能用 `dsh plugin allow-version <包@精确版本> --dsh-version <精确版本> --accept-risk` 做逐版本豁免。
- 桌面版（0.2.x）必须用它自带的 CLI 管 desktop profile：`"<安装目录>/resources/runtime/cli/bin/dsh.cmd" plugin --profile desktop add file:<路径>`——npm 全局的 `dsh` 可能是另一个旧版本，别混用。
- **会话事件 API 差异**：0.1.x 是 `session.events`（数组），0.2.x 是 `session.snapshotEvents()`；取事件一律走 `lib/llm-helper.ts` 的 `sessionEvents()` 兜底（0.2.1 上直接读 `session.events` 会 `Cannot read properties of undefined (reading 'length')`）。

## npm 发布

用 Trusted Publishing（OIDC）：`publish.yml` 需要 `permissions: id-token: write`，npm 包设置里配 Trusted Publisher（Quophic / dsh-persona-memory / publish.yml）。不要再用 `NPM_TOKEN`（旧 token 失效时 `npm publish` 返回 `E404 PUT ... could not be found or you do not have permission`，看起来像包不存在，其实是认证失败）。
