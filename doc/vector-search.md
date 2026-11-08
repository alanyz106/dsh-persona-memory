# 语义向量搜索（可选，默认关闭）

`memory_search` 默认走 **FTS5 全文检索**（字面匹配）；开启 `vectorEnabled` 后升级为**混合检索**。

## 设计要点

- **存储不变**：MEMORY.md / USER.md / failures.md 仍是唯一真相源，与 Pi 逐字节共用不变。
- **索引在 DSH 侧**：`.memory-vec.sqlite` 存在 `vectorIndexDir`（默认 `$DSH_HOME/memory`），**只存 embedding 数据**（向量 BLOB + sha256 指纹），Pi 完全不感知；索引可随时删除重建。
- **指纹增量同步**：每次搜索前对比条目 sha256，**只对新增/变化的条目重新 embedding**——Pi 改共享文件后自动跟上，不重复计算存量。
- **混合排序**：FTS5 精确匹配 + 向量语义匹配通过 **RRF（倒数排名融合）** 合并；向量不可用自动降级 FTS5/子串。
- **注入成本不变**：结果仍 ≤ `searchMaxResults` 条、只进工具输出，不常驻上下文。

## 启用

```yaml
- id: persona-memory
  config:
    vectorEnabled: true
    embeddingProvider: local
    # embeddingModel: Xenova/all-MiniLM-L6-v2   # 默认，可换
    # embeddingCacheDir: C:/Users/xxx/.dsh/models
    # embeddingRemoteHost: https://hf-mirror.com  # 大陆镜像
```

**本地模型自动下载**：`embeddingProvider: local` 时插件自带 `@xenova/transformers`，首次使用自动从 HuggingFace 下载模型（默认约 80MB）到 `$DSH_HOME/models`，之后完全离线运行；下载进度打印到 dsh 日志。网络受限时用 `embeddingRemoteHost: https://hf-mirror.com`。

**远程方案（备选）**：`embeddingProvider: remote` + `embeddingBaseUrl`（如 `https://api.openai.com/v1`）+ `embeddingApiKey`（或 `DSH_EMBEDDING_API_KEY`）。DeepSeek 官方 `/v1/embeddings` 曾出现可用性问题（[DeepSeek-R1#652](https://github.com/deepseek-ai/DeepSeek-R1/issues/652)），不建议依赖。

## CJK 检索

原生 FTS5 的 unicode61 分词器把一整段汉字当成一个 token，所以中文**子串**查询匹配不到任何东西。`lib/cjk-tokenizer.ts` 把中文查询展开成 bigram 并用 OR 连接（`包管理器` → `"包管" OR "管理" OR "理器"`），靠排名把命中更多词条的条目排前面。这也是本 fork 存在的主要理由。
