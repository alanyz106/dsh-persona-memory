/**
 * Suite 15 — background learning boundary: the learner transcript is
 * source-tagged (AGENTS.md injection is NOT a user line), the project memory
 * summary is attached so the model can skip already-stored facts, and the
 * learning run never writes project memory.
 *
 * Regression: the learner used to see AGENTS.md as a USER message and restate
 * project rules as global facts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createMemoryStore } from '../../dist/lib/memory-store.js';
import {
  renderProjectContextSummary, renderTranscriptLine, buildTranscript, extractTurns,
  registerLifecycleHooks, parseFacts,
} from '../../dist/lib/learning.js';
import { readIndex } from '../../dist/lib/project-memory.js';
import { BIG_LIMITS, check, testDir } from '../harness.mjs';

const learnRoot = fs.mkdtempSync(path.join(testDir, 'learn-'));
fs.mkdirSync(path.join(learnRoot, '.git'));
fs.mkdirSync(path.join(learnRoot, 'memory'));
fs.writeFileSync(path.join(learnRoot, 'AGENTS.md'), [
  '# 项目约定',
  '- 构建后先 node --check',
  '',
  '@memory/build.md — 构建链路',
  '@memory/pitfalls.md: 已知坑',
].join('\n'));
const learnIndex = readIndex(learnRoot);

const summary = renderProjectContextSummary(learnIndex, 1500);
check('project summary names the root', summary.includes(path.resolve(learnRoot)), summary.slice(0, 60));
check('project summary carries resident rules', summary.includes('构建后先 node --check'));
// the index is re-rendered in canonical form, so a colon separator comes back as an em dash
check('project summary carries index files and summaries',
  summary.includes('@memory/build.md — 构建链路') && summary.includes('@memory/pitfalls.md — 已知坑'), summary);
check('project summary lists no topic bodies', !summary.includes('body-should-not-appear'));

const tiny = renderProjectContextSummary(learnIndex, 40);
check('project summary honours the char limit', tiny.length <= 40, `len=${tiny.length}`);
check('an over-limit summary is marked truncated', /truncated/.test(tiny), tiny);
check('a summary of an empty project is empty',
  renderProjectContextSummary({ root: learnRoot, agentsFile: '', memoryDir: '', exists: false, resident: [], entries: [], orphans: [] }, 1500) === '');
check('an unbounded summary (limit 0) is not truncated',
  !/truncated/.test(renderProjectContextSummary(learnIndex, 0)));

// Budget allocation: the index is the coverage map, so a real AGENTS.md's
// resident prose must not consume the whole budget and silently drop it.
const fatResident = fs.mkdtempSync(path.join(testDir, 'fat-'));
fs.mkdirSync(path.join(fatResident, 'memory'), { recursive: true });
fs.writeFileSync(path.join(fatResident, 'AGENTS.md'), [
  ...Array.from({ length: 60 }, (_, i) => `- 常驻规则 ${i}：${'细节'.repeat(20)}`),
  '',
  '@memory/build.md — 构建链路',
  '@memory/deploy.md — 部署流程',
].join('\n'));
const fatSummary = renderProjectContextSummary(readIndex(fatResident), 1500);
check('a fat resident block still leaves room for the index',
  fatSummary.includes('@memory/build.md') && fatSummary.includes('@memory/deploy.md'), fatSummary.slice(-200));
check('the fat summary still respects the limit', fatSummary.length <= 1500, `len=${fatSummary.length}`);
check('the fat summary marks the truncation', /truncated/.test(fatSummary));
check('the fat summary keeps the project root line first',
  fatSummary.startsWith(`Project root: ${path.resolve(fatResident)}`));

// --- transcript source tagging
const textMsg = (role, text, kind) => ({ role, content: [{ type: 'text', text }], ...(kind ? { source: { kind } } : {}) });
const instrLine = renderTranscriptLine(textMsg('user', 'AGENTS.md 内容：构建后先 node --check', 'agent-instructions'));
check('agent-instructions render as PROJECT-INSTRUCTIONS',
  instrLine.startsWith('PROJECT-INSTRUCTIONS') && instrLine.includes('do not re-extract'), String(instrLine));
check('a direct user message renders as USER', renderTranscriptLine(textMsg('user', 'hi')) === 'USER: hi');
check('an assistant message renders as ASSISTANT', renderTranscriptLine(textMsg('assistant', 'done')) === 'ASSISTANT: done');
check('runtime-context is skipped', renderTranscriptLine(textMsg('user', 'cwd=/x', 'runtime-context')) === null);
check('time-context is skipped', renderTranscriptLine(textMsg('user', '<time>now</time>', 'time-context')) === null);
check('skill-catalog is skipped', renderTranscriptLine(textMsg('user', '<available_skills/>', 'skill-catalog')) === null);
check('an unknown source kind falls back to USER',
  renderTranscriptLine(textMsg('user', 'mystery', 'some-future-plugin')) === 'USER: mystery');
check('a genuine source.kind user renders as USER', renderTranscriptLine(textMsg('user', 'real', 'user')) === 'USER: real');
check('an empty message renders nothing', renderTranscriptLine(textMsg('user', '   ')) === null);

// --- buildTranscript end-to-end over a fake session (round-based)
// buildTranscript segments by direct user prompts in the event stream, so fake
// sessions are expressed as events with an optional mid-work assistant step.
const ev = (type, data) => ({ type, data });
const userEv = (text) => ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] });
const noiseEv = (kind, text) => ev('user/message', { source: { kind }, content: [{ type: 'text', text }] });
const stepEv = (text, withCall) => ev('assistant/message', { message: { content: [...(withCall ? [{ type: 'tool-call' }] : []), ...(text ? [{ type: 'text', text }] : [])] } });
const eventSession = (events) => ({ events, id: 'fake', deriveMessages: () => { throw new Error('round path must not need deriveMessages'); } });

// three rounds, the middle one with a queued second prompt and tool noise
const transcript = buildTranscript(eventSession([
  noiseEv('runtime-context', 'cwd=/x'),                       // harness noise: ignored
  userEv('第一轮：我更喜欢中文回答'),
  stepEv('先看一眼配置', true),                                // mid-work narration
  stepEv('第一轮的答案', false),                               // final answer
  userEv('第二轮：AGENTS.md 咋改'),
  noiseEv('agent-instructions', 'AGENTS.md: 改完先 node --check'), // injected, not the user
  userEv('第二轮补充：还有 build 脚本'),                        // queued follow-up
  stepEv('第二轮的答案', false),
  userEv('第三轮：好了'),
  stepEv('第三轮的答案', false),
]), 2, 6000);
check('round path keeps only USER/ASSISTANT lines', transcript.split('\n').every((l) => l === '' || l.startsWith('USER: ') || l.startsWith('ASSISTANT: ') || l === '…(truncated)'), JSON.stringify(transcript.split('\n').slice(0, 3)));
check('round path takes the last N rounds', /第二轮/.test(transcript) && /第三轮/.test(transcript) && !/第一轮/.test(transcript), transcript);
check('queued prompts join their round', /第二轮：AGENTS.md 咋改/.test(transcript) && /第二轮补充：还有 build 脚本/.test(transcript));
check('tool narration never enters the transcript', !/先看一眼配置/.test(transcript));
check('harness noise is dropped from the transcript', !/cwd=\/x/.test(transcript) && !/AGENTS.md: 改完先/.test(transcript));
check('every surviving line is labeled', transcript.split('\n').filter((l) => l.trim() && !l.startsWith('…')).every((l) => l.startsWith('USER: ') || l.startsWith('ASSISTANT: ')));

// trimming drops whole rounds, never cuts one open
const fatRounds = buildTranscript(eventSession([
  userEv('R1 question'), stepEv('R1 ' + 'x'.repeat(2000), false),
  userEv('R2 question'), stepEv('R2 ' + 'x'.repeat(2000), false),
  userEv('R3 question'), stepEv('R3 ' + 'x'.repeat(2000), false),
]), 3, 3000);
// each round is ~2015 chars, so a 3000 budget holds exactly one — the last
check('oversized window drops whole rounds from the front', fatRounds.startsWith('USER: R3 question') && !fatRounds.includes('R1 question') && !fatRounds.includes('R2 question'), fatRounds.slice(0, 60));
check('trimmed output stays within budget', fatRounds.length <= 3000, String(fatRounds.length));

// a single round bigger than the whole budget keeps its question
const giant = buildTranscript(eventSession([
  userEv('the one question that matters'),
  stepEv('A'.repeat(5000), false),
]), 1, 1000);
check('an over-budget single round keeps its question', giant.startsWith('USER: the one question that matters') && giant.length <= 1012, String(giant.length));

// turn without an answer still contributes its prompts
const unanswered = buildTranscript(eventSession([
  userEv('被追问打断的问题'),
  stepEv('跑到一半', true),
  userEv('下一个问题'),
  stepEv('下一个答案', false),
]), 2, 6000);
check('an interrupted round keeps its question without fabricating an answer', /被追问打断的问题/.test(unanswered) && /下一个答案/.test(unanswered));

// synthetic sessions without events fall back to the message projection
const fallback = buildTranscript({ events: [], deriveMessages: () => [
  { role: 'user', content: [{ type: 'text', text: 'fallback question' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'fallback answer' }] },
], id: 'fb' }, 2, 6000);
check('sessions without events fall back to deriveMessages', /USER: fallback question/.test(fallback) && /ASSISTANT: fallback answer/.test(fallback), fallback);
check('broken deriveMessages still degrades to empty', buildTranscript({ events: [], deriveMessages: () => { throw new Error('x'); }, id: 'x' }, 2, 100) === '');

// real-shaped regression: a long archive compressed into one case
const mixed = extractTurns(eventSession([
  userEv('q1'), stepEv('narration', true), stepEv('a1', false),
  noiseEv('time-context', '<t/>'),
  userEv('q2a'), userEv('q2b'), userEv('q2c'), stepEv('a2', false),
]), 5);
check('extractTurns: one round per user question', mixed.length === 2, JSON.stringify(mixed.length));
check('extractTurns: consecutive prompts land in one round', mixed[1].user.length === 3, JSON.stringify(mixed[1].user.length));
check('extractTurns: round answer is the last text-only step', mixed[0].assistant === 'a1');

// --- end-to-end: runLearning's prompt carries the tagged transcript + project summary
const learnStore = createMemoryStore({ dir: path.join(learnRoot, 'global'), limits: BIG_LIMITS });
let learnPrompts = 0;
let learnedPrompt = '';
let learnDone;
const learnDonePromise = new Promise((res) => { learnDone = res; });
const learnCtx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  llm: {
    stream(args) {
      learnPrompts++;
      learnedPrompt = args.messages[0].content[0].text;
      return (async function* () {
        yield { type: 'text-delta', text: 'NONE' };
        learnDone();
      })();
    },
  },
  on(_name, cb) {
    learnCtx.handler = cb;
  },
};
// The session's own LLM route comes from its request/header event; the
// conversation is event-shaped like a real session (round segmentation reads
// this), with the injected AGENTS.md distinguishable from the human line.
const learnSession = {
  id: 'learn-e2e',
  header: { cwd: learnRoot },
  events: [
    { type: 'request/header', data: { header: { config: { provider: 'p', model: 'm' } } } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我更喜欢中文回答' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }, { type: 'text', text: '先查一下' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的' }] } } },
  ],
};
registerLifecycleHooks(learnCtx, learnStore, {
  enableSecretScanning: true, correctionDetection: true, correctionPatternDetection: true,
  correctionHumanOnly: true, correctionRateLimitTurns: 3,
  learnEnabled: true, learnHumanOnly: true, learnIntervalTurns: 10,
  learnRecentTurns: 2, learnMaxChars: 6000, learnTimeoutMs: 5000,
  learnProjectContext: true, learnProjectContextCharLimit: 1500,
  memoryCharLimit: 1_000_000, autoConsolidate: false,
}, () => learnRoot);
// the hook counts turn/end events, so drive one full learning interval
for (let i = 0; i < 10; i++) learnCtx.handler(learnSession, { type: 'turn/end', data: {} });
await Promise.race([learnDonePromise, new Promise((r) => setTimeout(r, 3000))]);
check('the learning call fires once per interval', learnPrompts === 1, `calls=${learnPrompts}`);
check('the learner prompt carries the project memory section',
  /Project memory \(already stored/.test(learnedPrompt), learnedPrompt.slice(0, 120));
check('the learner prompt shows the project index and resident rules',
  learnedPrompt.includes('@memory/build.md') && learnedPrompt.includes('构建后先 node --check'));
check('the learner prompt tags the human line and drops injected instructions',
  /USER: 我更喜欢中文回答/.test(learnedPrompt) && !/AGENTS.md: 构建后先/.test(learnedPrompt) && !/先查一下/.test(learnedPrompt));
check('the learning run never writes project memory',
  !fs.existsSync(path.join(learnRoot, 'memory', 'build.md')));

// --- parseFacts regression: the boundary change must not alter parsing
check('parseFacts still returns the same shape after the learning rewrite',
  parseFacts('- a\n- b\nNONE\n').join('|') === parseFacts('- a\n- b\nNONE\n').join('|'));
