# 自动能力与检索实现

## 自动学习与纠正

`lib/learning.ts` + `lib/correction.ts`：

- 后台学习：每 `learnIntervalTurns`（默认 10）轮，用会话自身的 LLM 路由复习近期对话并 `store.add` 事实。
- 纠正检测：`feedback/record` 事件 + 对话内模式检测（强/弱/负向模式 + 指令词，仅 `source.kind === 'user'` 的直接人工消息，`correctionRateLimitTurns` 限频）→ 存 `[correction]` 失败条目。
- 用量提示：`usageNudgeThreshold`（默认 0.9）。

## 会话分级

`lib/sessions.ts` 的 `sessionCapturePolicy` 按 session header 区分人类主会话与派生会话（`origin === 'subagent'` / `parentSession` / `delegationDepth > 0`）。派生会话默认不注入记忆（`injectHumanOnly`）、不后台学习（`learnHumanOnly`）、不产生纠正条目（`correctionHumanOnly`）。

## 自动合并

超限时用 LLM 合并，**严格更小 / 可解析 / 过扫描**才经 `replaceEntries` 提交；失败不损坏记忆，只留超预算状态。in-flight 锁按 `store.fileFor(which)` 分档，各 store 独立合并。

## FTS5 记忆镜像

`lib/fts.ts`，索引在 `<dir>/.memory-index.sqlite`：

- 动态 `import node:sqlite`，不可用则 `memory_search` 回退子串扫描。
- 按文件 mtime 自动重建，任何写入路径无需显式失效。
- 多关键词按空白分词，每词单独引号成短语，空格连接（FTS5 隐式 AND）——`Alex gardener macOS` 这类非相邻词能命中同一记忆，且每词仍是字面串，FTS5 语法永远当数据（防注入）。
- 中文用 bigram 投影（`lib/cjk-tokenizer.ts`）：默认 unicode61 把整段汉字当一个 token，`包管理器` 这类子串查询会全 miss。

## 向量记忆镜像

`lib/vector-index.ts` + `lib/embedding.ts`：

- 索引在 `vectorIndexDir`（默认 `$DSH_HOME/memory`）下 `.memory-vec.sqlite`，**只存 embedding**（entries 表：which / text_hash / text / embedding BLOB / created / last，UNIQUE(which, text_hash)）。
- 指纹增量同步（sha256 每条原始 § 条目），只重算变化项。
- 检索纯 JS 余弦（条目少，不装 sqlite-vec）。
- provider 二选一：`remote`（OpenAI 兼容 `/embeddings`，`embeddingBaseUrl` + `embeddingApiKey` 或 `DSH_EMBEDDING_API_KEY`）或 `local`（`@xenova/transformers`，首次用自动下载模型到 `embeddingCacheDir`，`embeddingRemoteHost` 可换镜像）。
- `vectorEnabled` 默认关；开后 `memory_search` 走 hybrid（FTS5 + 向量 RRF 融合），无向量则降级。

## 常驻指令

`lib/standing.ts` + `lib/standing-command.ts`：STANDING.md 每行一条，硬预算 20 条 / 2000 字符，始终注入（order 50）。只有 `/standing` 命令或直接编辑能写——模型无写入口，防止模型把"常驻指令"偷偷注入。

## 失败记忆

`lib/failures.ts`：failures.md 用 § 格式，结构化 `[category] 内容 — Failed: … — Corrected to: …`，最近 7 天 / 5 条注入（order 52），纠正检测落 failure 并去重。`which: 'failure'` 字符上限 = memory × 2。

## 写入并发安全

`lib/memory-store.ts` 的 add / update / remove 走**单锁原子 `mutate`**（一次 withLock 内完成读-改-写，`{ next?, value }` 返回协议），杜绝并发工具调用互相覆盖。写前做文件指纹预检（sha256）：若外部在我们读后改写了文件，不覆盖、重试一次、仍冲突则返回 `conflict: true`。

## 磁盘格式

`\n§\n` 分隔，行尾 `<!-- created=, last= -->` 元数据，无尾随换行；`charCount` = `entries.join(delimiter).length`（含分隔符）；容量超限**拒绝写入**（`overflow: true`，工具层可先合并后重试）；注入包 `<memory-context>` 围栏。
