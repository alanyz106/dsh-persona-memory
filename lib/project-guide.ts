/**
 * The project-memory authoring guide — what a good `AGENTS.md` looks like.
 *
 * This file is the single source of truth for "how to create project memory",
 * and it exists because the mechanism alone is not enough: a model handed
 * `project_memory` with no model of the *shape* writes either a prose
 * document into the resident block (paying for it on every request) or one
 * giant topic file (defeating lazy loading). The guide states the split and
 * the boundary rules once, here, and is rendered in two sizes:
 *
 *   - `projectCoreLines()` — the few lines injected on every request. Kept
 *     short because it competes with the resident rules themselves; it only
 *     needs to say what the two zones are and when to read vs write.
 *   - `projectGuideText()` — the full guide, fetched on demand via
 *     `project_memory` action `guide` (and shown in the WebUI card). This is
 *     where the examples, the budget numbers and the anti-patterns live.
 *
 * The full guide OPENS with the core lines, so the two renderings never drift
 * apart and nothing is stated twice in the source.
 */

/**
 * The always-injected essentials, in order. Rendered as bullet lines under a
 * `### Project memory` heading.
 *
 * Written in Chinese on purpose: the resident rules it competes with in a
 * Chinese-speaking user's repositories are Chinese too, and CJK carries more
 * constraint per token.
 */
export const PROJECT_CORE_LINES: readonly string[] = [
  '项目记忆分两区：`AGENTS.md` 的常驻区（除 `@` 行外的全部内容）每次请求都在上下文里，只放项目约定俗成、不做就会错的硬约束；末尾 `@memory/*.md` 索引行指向的主题文件按需读取。',
  '记账前先 `project_memory list` 看有没有同主题：有就 `append` 追加，没有才 `write`（`write` 带一行 `summary`，索引行自动维护）。',
  '架构说明、业务流程、踩坑日志、SOP、历史决策写进 `memory/<主题>.md`；一句话讲不清「为什么」的细节不要塞常驻区。',
  '跨项目的事实与用户偏好用全局 `memory` 工具；`project_memory guide` 取完整写法、边界规则与示例。',
];

/** One fence-safe code block: the guide contains ```markdown examples. */
const FENCE = '```';

/**
 * The full guide: core lines first (as a recap), then zones, boundaries,
 * workflow, a worked example and the anti-patterns.
 */
const GUIDE_BODY: readonly string[] = [
  '# 项目记忆写法（AGENTS.md：常驻区 + 检索区）',
  '',
  '## 速记',
  ...PROJECT_CORE_LINES.map((line) => `- ${line}`),
  '',
  '## 一、常驻区：AGENTS.md 正文（除 `@` 行以外的全部内容）',
  '',
  '常驻区是每次请求都在系统提示词里的上下文。放「不知道就会做错，而且每一次都可能用到」的东西：',
  '',
  '- 构建 / 测试 / 运行命令，以及**什么算过**的判定标准（例如 `npm run typecheck` + `node test/smoke.mjs` 全绿）',
  '- 禁改清单：生成物、锁文件、别人的目录、生产配置、`peerDependencies` 这类一改就炸全局的硬规范',
  '- 必守的编码 / 命名 / 目录约定、分支策略、提交信息格式',
  '- 部署与发布约束：只能从某个分支发、打 tag 才触发发布、push 前必须人工确认',
  '- 环境怪癖：必须用哪个 profile / 哪个 CLI / 哪个 Node 版本，哪个命令看起来对但不能用',
  '- 一两句话说明项目是什么、给谁用（定位领域，细节不展开）',
  '',
  '写法要求：',
  '',
  '1. **一行一条祈使句**，能执行、能验证——「改代码后先 `npm run build`」，不是「注意构建」。',
  '2. **保留原始措辞**：插件只增删整行，不改写你的句子；`migrate` 也只做搬移不重写。',
  '3. 不写长理由、不写历史、不写只查一次的细节——这些进检索区。',
  '4. 预算 `projectResidentCharLimit`（默认 3000 字符）。超了**拒绝写入**、不静默裁剪：把细节挪进主题文件。',
  '',
  '## 二、检索区：末尾 `@memory/*.md` 索引行 + `memory/` 主题文件',
  '',
  '索引行本身很短，只回答一个问题：**什么时候该读这个文件**。',
  '',
  `${FENCE}markdown`,
  '@memory/build.md — 构建、类型检查、冒烟测试的命令与产物位置',
  '@memory/pitfalls.md — 踩过的坑：现象 → 根因 → 修法',
  `${FENCE}`,
  '',
  '行级识别：`@memory/<path>.md` 后可跟 `—` / `–` / `--` / `:` 加一行描述；允许 `-` / `*` / `+` 列表前缀。',
  '',
  '该放进主题文件的：',
  '',
  '- **踩坑日志 / 失败教训**：一坑一小节，写「现象 → 根因 → 修法 → 如何验证」；用 `append` 追加，别重写整篇。',
  '- **架构与数据流**：模块地图、请求路径、注入顺序、关键数据结构。',
  '- **业务流程 / 外部接口**：第三方服务、鉴权、限流、回调、计费口径。',
  '- **迁移 / 发布 SOP、上线检查清单**：可照着执行的步骤序列。',
  '- **历史决策**：为什么这么做、哪些方案被否掉及原因（防止后人重走死路）。',
  '',
  '组织方式：',
  '',
  '- 一主题一文件，文件名小写连字符：`memory/build.md`、`memory/release-sop.md`、`memory/pitfalls.md`。',
  '- 单文件上限 `projectFileCharLimit`（默认 20000 字符），索引区上限 `projectIndexCharLimit`（默认 4000 字符）。',
  '- 主题多于 5 个、或某个文件接近 15000 字符，就该拆分或合并了；`search` 是跨文件子串检索，找不到往往是主题名起错了。',
  '',
  '## 三、边界：这条内容该写到哪里',
  '',
  '| 内容 | 写到哪 |',
  '|---|---|',
  '| 用户偏好、跨项目事实、通用环境怪癖 | 全局 `memory` 工具（MEMORY.md / USER.md） |',
  '| 只在这个仓库成立的约定、架构、坑、SOP | 项目记忆（AGENTS.md + memory/） |',
  '| 用户亲笔、始终生效、高于模型默认行为 | `/standing`（STANDING.md），模型无写入口 |',
  '',
  '三条判据：',
  '',
  '1. **换个仓库还成立 → 全局；只在这里成立 → 项目。**',
  '2. **「不做就会错」→ 常驻区；「做的时候查一下」→ 主题文件。**',
  '3. 拿不准就先写主题文件——从检索区升级到常驻区的成本，远低于反过来。',
  '',
  '## 四、创建与维护流程',
  '',
  '1. 先看现状：`project_memory list`（索引 + 孤儿文件 + 各区用量）。',
  '2. 空项目起步：先 `write` 1–2 个主题文件（如 `memory/build.md`、`memory/pitfalls.md`），再 `add_resident` 加 3–8 条硬约束。别反过来——先把常驻区塞满会让你舍不得删。',
  '3. 每次学到东西：同主题 `append`；新主题才 `write`；只影响「下次怎么做」的一句话才进常驻区。',
  '4. 规则失效：`update`（不给 file）按子串定位常驻行并就地替换，主题文件同理给 `file`；细节沉进主题文件。',
  '5. 已有散文 AGENTS.md：走 `migrate`（先 `apply: false` 预览计划），它按标题保全校验拆分，原文另存 `AGENTS.md.bak-<时间戳>`。',
  '6. 路径只能是 `memory/**.md`，`..`、绝对路径、dotfile 一律被拒；写入前过内容扫描，凭据 / 提示注入载荷会被拦下。',
  '',
  '## 五、一个真实的 AGENTS.md 示例',
  '',
  `${FENCE}markdown`,
  '# AGENTS.md — <仓库名> 开发约定',
  '',
  '<一两句：这个项目是什么、给谁用>。本文件的常驻规则每次请求都生效；具体知识在末尾索引指向的文件里。',
  '',
  '## ⚠️ 首要规范：<最容易炸的那一条>',
  '',
  '- <硬规范，一句话；违反的后果一句话>',
  '- 为什么：<一句话，长解释进 memory/pitfalls.md>',
  '',
  '## 硬性流程',
  '',
  '- **改代码后先构建**：`npm run build`',
  '- **提交前必须全绿**：`npm run typecheck` + `node test/smoke.mjs`',
  '- **只在 main 分支工作**；commit 可自动，push 必须人工确认',
  '- 测试严禁删真实数据目录，一律用临时目录',
  '',
  '@memory/overview.md — 项目定位、模块地图、注入顺序',
  '@memory/architecture.md — 关键实现细节与数据结构',
  '@memory/pitfalls.md — 踩坑日志：现象 → 根因 → 修法',
  '@memory/release-sop.md — 迭代与上线 SOP、git 工作流',
  `${FENCE}`,
  '',
  '## 六、不要这样做',
  '',
  '- 把整份 README / 架构文档粘进常驻区 → 每次请求都付费，还挤掉真正的硬约束。',
  '- 索引行写「杂项」「其他」「notes」→ 模型无法判断何时该读，等于没索引。',
  '- 把所有内容塞进一个 `memory/all.md` → 失去按需加载的意义，单文件也最先撞预算。',
  '- 在项目记忆里写 token、私钥、密码、内网地址 → 写入会被扫描器拒绝，也不该落盘。',
  '- 把「用户喜欢简洁回答」这类跨项目偏好写进某个仓库 → 那是全局 `memory` 的活。',
];

/**
 * @returns the full authoring guide (markdown), for `project_memory guide`
 * and the WebUI panel
 */
export function projectGuideText(): string {
  return GUIDE_BODY.join('\n');
}

/**
 * Whether a project already keeps memory.
 *
 * Shared by the injection gate and the registry decision so the two can never
 * disagree: a repository counts as "has memory" once it has either resident
 * rules or at least one `@memory/` pointer. An empty `AGENTS.md` or a bare
 * `memory/` directory with no index does not count — those are drafts, and the
 * project still needs the bootstrap hint.
 */
export function projectHasMemory(index: { entries: unknown[]; resident: unknown[] }): boolean {
  return index.entries.length > 0 || index.resident.length > 0;
}

/**
 * @returns the per-request essentials, one bullet line each
 */
export function projectCoreLines(): string[] {
  return PROJECT_CORE_LINES.map((line) => `- ${line}`);
}

/**
 * The block injected for a project that has no memory yet.
 *
 * Without it a fresh repository is invisible: the tool exists, but nothing in
 * context says the project keeps memory or what shape it should take, so the
 * model never bootstraps one (this was the actual gap, not the tool).
 *
 * @param root absolute project root
 */
export function projectBootstrapBlock(root: string): string {
  return [
    '### 项目记忆',
    `本仓库（\`${root}\`）还没有项目记忆（无 \`AGENTS.md\`，无 \`memory/\`）。学到会长期成立的东西时——构建/测试命令、不能破的约定、架构、刚踩过的坑——用 \`project_memory\` 记下来：`,
    ...projectCoreLines(),
  ].join('\n');
}
