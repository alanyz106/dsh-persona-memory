# 安装到 DSH profile

**兼容范围**：dsh `0.1.0-rc.6 ~ 0.2.x`（peer 范围 `^0.1.0-rc.6 || ^0.2.0-rc.1`）。桌面版（Desktop profile）与 npm/CLI 版（web profile）都能装。0.2.x 起 dsh 会按 peer 范围做版本闸门，声明不匹配会被判 `incompatible-version` 并拒绝加载。

## 构建产物从哪来

源码是 **TypeScript**（`index.ts` + `lib/*.ts` + `client/src/*.ts`），发布产物由构建生成：

```bash
npm run build
# = tsc -p tsconfig.json        → dist/（Host 半区）
# + node scripts/build-client.mjs → client/client.js（浏览器端 bundle）
```

`dist/` 和 `client/client.js` 都在 `.gitignore` 里，是**构建产物而不是源码**：git clone 下来的仓库不能直接安装，必须先构建，或直接用 Release 里的 tgz。

插件声明了 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，安装后 dsh **自动激活**为 profile 层，无需手动挂载。

## 从 Release 安装（推荐）

Release 附件就是 npm 包的形状（含 `dist/` 与 `client/client.js`），目标机器不需要构建链：

```bash
# 固定版本
dsh plugin --profile web add \
  https://github.com/alanyz106/dsh-persona-memory/releases/download/v0.0.8/dsh-persona-memory.tgz

# 或跟随最新
dsh plugin --profile web add \
  https://github.com/alanyz106/dsh-persona-memory/releases/latest/download/dsh-persona-memory.tgz
```

## 从本地副本安装

```bash
npm run build            # 本地开发每次改代码后必做
dsh plugin --profile web add file:<本仓库路径>
```

`file:` 安装是**真实副本**：改代码后须重新构建、`remove` 再 `add`（pnpm 有 store 缓存，只 `add` 可能装回旧副本），最后重启 web。

```bash
dsh plugin --profile web remove @alanyz106/dsh-persona-memory
dsh plugin --profile web add file:E:/path/to/dsh-persona-memory
dsh --profile web
```

桌面版 0.2.x 用安装目录自带的 CLI，profile 名换成 `desktop`：

```powershell
"D:/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd" plugin --profile desktop add file:E:/GitHub/lian_dsh
```

## 升级不会重置配置

插件配置不在包里，而在 profile 的用户层文件 `~/.dsh/profiles/<profile>/cordis.patch.yml` 的 `persona-memory` 段。包内 `cordis.patch.yml` 只有激活行、没有 `config:`，因此 `remove` + `add` 不会覆盖你的设置；同理 `MEMORY.md`、`USER.md`、`STANDING.md` 与仓库里的 `AGENTS.md` / `memory/` 也都不在包内。

升级前想保险可以先备份：

```bash
cp ~/.dsh/profiles/<profile>/cordis.patch.yml \
   ~/.dsh/profiles/<profile>/cordis.patch.yml.bak
```

会丢配置的只有：删掉并重建 profile、`--from-default-profile`、手动覆盖 patch、或换了 `DSH_HOME` / `--profile` 导致读的是另一份 patch。

## 覆盖配置

profile 的 `cordis.patch.yml` 里按 id 覆盖即可（bundle 行在后层，会被 profile 行覆盖）：

```yaml
- id: persona-memory
  config:
    dir: C:/Users/you/.dsh/memory
```

可覆盖的键见 [config.md](config.md)。
