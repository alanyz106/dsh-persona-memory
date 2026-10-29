/**
 * Lifecycle hooks — the "auto" half of dsh-persona-memory.
 *
 * 1. Correction detection: on the durable `feedback/record` session event
 *    (the /feedback command), save a `[correction]` failure entry to
 *    failures.md immediately — the model cannot learn from feedback that
 *    arrives after its own message, so this is a host-side hook.
 * 2. Background learning: count `turn/end` events per session and every
 *    `learnIntervalTurns` turns call the session's own LLM route to review
 *    the recent transcript and extract durable facts, saving them via the
 *    store. All writes still pass the content scanner.
 *
 * Background learning writes the GLOBAL stores only. Project knowledge is
 * excluded by design: splitting it into resident rules + topic files needs the
 * full project context and the main model already does it better through
 * `project_memory`. To make that exclusion enforceable the learner is shown a
 * compact summary of the current project's memory (resident rules + index
 * descriptions) and told to skip anything already covered there.
 */
import { scanContent } from './secret-scanner.js';
import { callLlm, latestRoute, sessionEvents, type LlmRoute } from './llm-helper.js';
import { maybeConsolidate, type ConsolidationConfig } from './consolidate.js';
import { buildFailureText } from './failures.js';
import { extractCorrectionDirective, isCorrection } from './correction.js';
import { renderAgents, readIndex, resolveProjectRoot, type ProjectIndex } from './project-memory.js';
import { isDerivedSession } from './sessions.js';
import type { MemoryStore } from './memory-store.js';
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';

const LEARNING_SYSTEM_PROMPT = `You are a memory curator for a coding agent that persists long-term persona memory across sessions.

Read the recent conversation transcript and extract durable, factual entries worth remembering later in the GLOBAL memory: user preferences and identity facts, environment details, machine/tool quirks, and lessons that hold across repositories, and anything already covered by the current memory below.

Project-specific knowledge is NOT yours to store. Rules, conventions, build/deploy quirks, and architecture decisions that hold only inside one repository belong to that repository's project memory, which the working agent maintains itself. Test every candidate with: "would this still be true in a different repository?" If not, skip it.

Rules:
- Output ONLY plain lines, one fact per line. No numbering, no bullet markers, no markdown fences, no JSON, no commentary.
- Keep each fact self-contained and concise (under 300 chars), written in the language of the conversation.
- Only output NEW facts that are not already in the current memory.
- The transcript tags each line by source:
  - \`USER:\` — the human typed it. The only reliable source of user preferences and identity.
  - \`ASSISTANT:\` — the agent said it. Useful for distilled lessons, but it is not evidence of what the user wants.
  - \`PROJECT-INSTRUCTIONS: ...\` — workspace instructions the harness injected (AGENTS.md and friends). This text is ALREADY stored in project memory. Never restate any of it as a new fact, and never treat its content as something the user said.
- "Project memory" below lists what the current repository already stores (resident rules plus one line per topic file). If a candidate fact is already covered there, skip it — do not duplicate it into global memory.
- If there is nothing worth saving, output the single line: NONE`;

// NOTE: this in-flight guard is intentionally module-scoped — runLearning is a
// top-level function and must share one registry across every session. (The
// original JS declared it inside registerLifecycleHooks, which made runLearning
// throw ReferenceError on its first use and silently disabled background
// learning; fixed here by hoisting it to module scope.)
/** sessions with a learning call in flight */
const inflight = new Set<string>();

export interface LearningConfig extends ConsolidationConfig {
  enableSecretScanning: boolean;
  correctionDetection: boolean;
  correctionPatternDetection: boolean;
  /** Only run correction detection in human-driven sessions. */
  correctionHumanOnly: boolean;
  correctionRateLimitTurns: number;
  learnEnabled: boolean;
  /** Only run background learning in human-driven sessions. */
  learnHumanOnly: boolean;
  learnIntervalTurns: number;
  learnRecentTurns: number;
  learnMaxChars: number;
  learnTimeoutMs: number;
  /** Show the learner a summary of the project's memory so it can skip duplicates. */
  learnProjectContext: boolean;
  /** Character budget for that summary (resident rules + index lines). */
  learnProjectContextCharLimit: number;
  memoryCharLimit: number;
  autoConsolidate: boolean;
}

/** Injected by the host: the working directory of the session being learned. */
export type SessionCwdOf = (session: Session | unknown) => string | null;

/**
 * What this session is allowed to feed back into memory. Derived sessions
 * (subagent / workflow child / AgentTeams member) execute delegated work; their
 * chatter must not become user facts or corrections, and a main session keeps
 * the historical behavior.
 * @returns the two independent switches the session/event hook consults
 */
export function sessionCapturePolicy(
  cfg: Pick<LearningConfig, 'learnEnabled' | 'correctionDetection' | 'learnHumanOnly' | 'correctionHumanOnly'>,
  session: unknown,
): { learning: boolean; corrections: boolean } {
  const derived = isDerivedSession(session);
  return {
    learning: cfg.learnEnabled && !(cfg.learnHumanOnly && derived),
    corrections: cfg.correctionDetection && !(cfg.correctionHumanOnly && derived),
  };
}

export function registerLifecycleHooks(
  ctx: Context,
  store: MemoryStore,
  cfg: LearningConfig,
  cwdOf?: SessionCwdOf,
): void {
  /** turn counts per session id */
  const turnCounts = new Map<string, number>();
  /** sessions with a pending in-chat correction this turn */
  const pendingCorrections = new Set<string>();
  /** turns since last correction save, per session */
  const turnsSinceCorrection = new Map<string, number>();

  ctx.on('session/event', (session, event) => {
    try {
      const allowed = sessionCapturePolicy(cfg, session);
      if (!allowed.learning && !allowed.corrections) return;
      // In-chat correction detection — only on DIRECT human prompts
      // (source.kind === 'user'; synthetic contexts are 'plugin').
      if (event.type === 'user/message' && allowed.corrections && cfg.correctionPatternDetection) {
        const msg = event.data;
        if (msg?.source?.kind === 'user') {
          const text = msg.content
            ?.filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join(' ')
            .trim();
          if (text && isCorrection(text, cfg)) {
            pendingCorrections.add(session.id);
          }
        }
        return;
      }
      if (event.type === 'turn/end') {
        // In-chat correction captured at turn end (rate-limited).
        if (pendingCorrections.has(session.id) && allowed.corrections && cfg.correctionPatternDetection) {
          pendingCorrections.delete(session.id);
          const since = turnsSinceCorrection.get(session.id) ?? cfg.correctionRateLimitTurns;
          if (since >= cfg.correctionRateLimitTurns) {
            turnsSinceCorrection.set(session.id, 0);
            const text = lastDirectUserText(session);
            if (text) {
              saveCorrection(store, cfg, extractCorrectionDirective(text)).catch((err) =>
                ctx.logger.warn('[dsh-persona-memory] correction save failed: %s', (err as Error | undefined)?.message ?? String(err)),
              );
            }
          } else {
            turnsSinceCorrection.set(session.id, since + 1);
          }
        } else {
          turnsSinceCorrection.set(session.id, (turnsSinceCorrection.get(session.id) ?? 0) + 1);
        }
        if (allowed.learning) {
          const n = (turnCounts.get(session.id) ?? 0) + 1;
          if (n >= cfg.learnIntervalTurns) {
            turnCounts.set(session.id, 0);
            runLearning(ctx, store, cfg, session, cwdOf).catch((err) =>
              ctx.logger.warn('[dsh-persona-memory] background learning failed: %s', (err as Error | undefined)?.message ?? String(err)),
            );
          } else {
            turnCounts.set(session.id, n);
          }
        }
      }
    } catch (err) {
      // containment: a hook bug must never break the session event fan-out
      ctx.logger.warn('[dsh-persona-memory] session/event hook error: %s', (err as Error | undefined)?.message ?? String(err));
    }
  });
}

/**
 * Last direct user text from the session surface (for the correction entry).
 */
function lastDirectUserText(session: Session): string {
  const events = sessionEvents(session);
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as
      | {
          type?: string;
          data?: {
            source?: { kind?: string };
            content?: readonly { type: string; text?: string }[];
          };
        }
      | undefined;
    if (event?.type === 'user/message' && event.data?.source?.kind === 'user') {
      return (
        event.data.content
          ?.filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join(' ')
          .trim() ?? ''
      );
    }
  }
  return '';
}

/**
 * Persist one correction as failure memory (category `correction`). Called from
 * the /correct command (explicit user intent) and from in-chat pattern
 * detection (rate-limited). Deduped; overflow/conflict drops the entry.
 */
export async function saveCorrection(store: MemoryStore, cfg: LearningConfig, text: string): Promise<void> {
  // Corrections are captured as failure memory (category correction) — they
  // surface in the injected recent-failures block so the model learns from
  // them, and stay out of MEMORY.md unless promoted by an explicit add.
  const entry = buildFailureText(text, { category: 'correction' });
  if (cfg.enableSecretScanning && scanContent(entry)) return;
  const result = await store.add('failure', entry, { dedupe: true });
  if (!result.overflow && !result.conflict) return;
  // Over budget or a concurrent external write — the correction simply does
  // not land this time; consolidation of failure memory is rare and the
  // failure block only injects the most recent entries anyway.
  // eslint-disable-next-line no-console
  console.warn('[dsh-persona-memory] correction save skipped (overflow/conflict): %s', entry.slice(0, 80));
}

async function runLearning(
  ctx: Context,
  store: MemoryStore,
  cfg: LearningConfig,
  session: Session,
  cwdOf?: SessionCwdOf,
): Promise<void> {
  if (inflight.has(session.id)) return;
  inflight.add(session.id);
  try {
    const route = latestRoute(session);
    if (!route) return;
    const transcript = buildTranscript(session, cfg.learnRecentTurns, cfg.learnMaxChars);
    if (!transcript) return;
    const current = store.readSync('memory', cfg.learnMaxChars).content;
    // What the project already stores, so the learner can skip it instead of
    // writing the same rules into the global store. Missing project / missing
    // AGENTS.md / a read failure all collapse to '' (the section is omitted).
    const projectContext = cfg.learnProjectContext ? projectContextFor(cfg, session, cwdOf) : '';
    const sections = [
      `Recent conversation transcript:\n---begin---\n${transcript}\n---end---`,
      `Current memory:\n${current || '(empty)'}`,
    ];
    if (projectContext) {
      sections.push(`Project memory (already stored in this repository — do NOT re-extract, do NOT duplicate into global memory):\n---begin---\n${projectContext}\n---end---`);
    }
    const reply = await callLlm(ctx, route, LEARNING_SYSTEM_PROMPT, sections.join('\n\n'), cfg.learnTimeoutMs);
    const facts = parseFacts(reply);
    for (const fact of facts) {
      if (cfg.enableSecretScanning && scanContent(fact)) continue;
      const added = await store.add('memory', fact);
      if (added.overflow) {
        // Store is at capacity and refused the write (hermes semantics).
        // Consolidate once and retry; if still refused, drop this fact
        // rather than silently growing past the limit.
        const limit = cfg.memoryCharLimit;
        if (cfg.autoConsolidate && limit > 0) {
          await maybeConsolidate(ctx, store, route, cfg, 'memory');
          const retried = await store.add('memory', fact);
          if (!retried.overflow && !retried.conflict) continue;
        }
        ctx.logger.warn('[dsh-persona-memory] learning skipped fact at capacity: %s', fact.slice(0, 80));
      }
    }
    if (facts.length > 0) {
      ctx.logger.info('[dsh-persona-memory] learned %d fact(s) from %s', facts.length, session.id);
    }
    // Observability: background learning has no visible sink in every
    // deployment, so record what the run was actually given. `projectChars`
    // of 0 means the exclusion rule had no evidence to work from.
    ctx.logger.info(
      '[dsh-persona-memory] learning run %s: transcript=%d chars, projectContext=%d chars, facts=%d',
      session.id,
      transcript.length,
      projectContext.length,
      facts.length,
    );
    // If the learned facts pushed memory over budget, consolidate.
    const stat = await store.stat('memory');
    const limit = cfg.memoryCharLimit;
    if (stat.exists && stat.entryCount > 0 && limit > 0) {
      const raw = await store.listRaw('memory');
      if (raw.join('\n§\n').length > limit) {
        await maybeConsolidate(ctx, store, route, cfg, 'memory');
      }
    }
  } finally {
    inflight.delete(session.id);
  }
}

/** Share of the summary budget the topic index may claim before resident prose. */
const INDEX_BUDGET_SHARE = 0.4;

/**
 * Project memory as the learner needs to see it: the resident rules and the
 * `@memory/...` index descriptions — never the topic file bodies. Those are
 * lazily read by the working model, and pulling them in would blow both
 * `learnMaxChars` and the point of the split.
 *
 * Budget: the index is the coverage map ("this topic is already written down
 * somewhere"), so it gets first claim on up to `INDEX_BUDGET_SHARE` of the
 * budget and the resident prose takes the rest — truncating the tail. The
 * reverse order loses the index entirely on any repository with a real
 * AGENTS.md, which is precisely the case the summary exists for.
 *
 * @param index parsed AGENTS.md index
 * @param charLimit budget for the rendered summary; 0/negative = unbounded
 * @returns the summary, or '' when the project has nothing to summarize
 */
export function renderProjectContextSummary(index: ProjectIndex, charLimit: number): string {
  const resident = index.resident.join('\n').trim();
  if (!resident && index.entries.length === 0) return '';
  const marker = '…(truncated)';
  const rootLine = `Project root: ${index.root}`;
  const indexBlock = index.entries.length > 0
    ? `Topic files (index only — bodies are loaded on demand):\n${renderAgents([], index.entries).trim()}`
    : '';
  const residentBlock = resident ? `Resident rules (AGENTS.md):\n${resident}` : '';

  if (charLimit <= 0) {
    return [rootLine, residentBlock, indexBlock].filter(Boolean).join('\n');
  }
  // Spend on the index first, then the resident prose with what is left.
  const indexAllowance = Math.min(indexBlock.length, Math.floor(charLimit * INDEX_BUDGET_SHARE));
  const residentAllowance = charLimit - rootLine.length - indexAllowance - 2; // 2 separator newlines
  const fit = (block: string, allowance: number): string => {
    if (!block || allowance <= 0) return '';
    if (block.length <= allowance) return block;
    if (allowance <= marker.length) return '';
    return block.slice(0, allowance - marker.length) + marker;
  };
  const text = [rootLine, fit(residentBlock, residentAllowance), fit(indexBlock, indexAllowance)]
    .filter(Boolean)
    .join('\n');
  // A budget too small for the structure still has to respect the limit.
  if (text.length <= charLimit) return text;
  if (charLimit <= marker.length) return text.slice(0, charLimit);
  return text.slice(0, charLimit - marker.length) + marker;
}

/**
 * Resolve the session's project and summarize its memory.
 *
 * Every failure mode — no cwd, no project, unreadable AGENTS.md, a bug in the
 * renderer — must degrade to '' so background learning still runs. Learning
 * without the exclusion evidence is the old behavior; learning not running at
 * all is worse.
 */
function projectContextFor(cfg: LearningConfig, session: Session, cwdOf?: SessionCwdOf): string {
  if (!cwdOf) return '';
  try {
    const cwd = cwdOf(session);
    if (!cwd) return '';
    const root = resolveProjectRoot(cwd);
    if (!root) return '';
    const summary = renderProjectContextSummary(readIndex(root), cfg.learnProjectContextCharLimit);
    return summary;
  } catch {
    return '';
  }
}

/** A message as the transcript renderer needs it (structural, so tests need no Session). */
export interface TranscriptMessage {
  role: string;
  content: readonly { type: string; text?: string }[];
  source?: { kind?: string };
}

/** Synthetic context kinds with no learning value — pure system noise. */
const SKIPPED_SOURCES = new Set(['runtime-context', 'skill-catalog', 'time-context']);

/**
 * Render one transcript line, tagged by where the text actually came from.
 *
 * The harness injects whole files (AGENTS.md) as **user messages**, so a
 * role-only rendering makes project instructions look like something the user
 * said — which is exactly how the learner came to restate project rules as
 * global facts. Source kinds are merge-extensible, so unknown kinds fall
 * through to USER rather than being dropped.
 *
 * @returns `[label, text]`, or null when the message carries nothing worth showing
 */
export function renderTranscriptLine(msg: TranscriptMessage): string | null {
  const kind = msg.source?.kind;
  if (kind && SKIPPED_SOURCES.has(kind)) return null;
  const text = msg.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join(' ')
    .trim();
  if (!text) return null;
  if (kind === 'agent-instructions') {
    return `PROJECT-INSTRUCTIONS (already stored in project memory — do not re-extract): ${text}`;
  }
  return `${msg.role === 'assistant' ? 'ASSISTANT' : 'USER'}: ${text}`;
}

/**
 * One turn as the learner sees it: every message the human sent, then the
 * agent's final answer. Nothing in between — the tool-call stream is where the
 * agent spent 20 messages iterating on a build, and it teaches the curator
 * nothing about the user while crowding out the messages that do.
 */
export interface TranscriptTurn {
  /**
   * One entry per direct user message, in order. A turn can hold several: the
   * user sends one thought, sees the agent start, then sends another. Each is
   * kept separately — collapsing them into one paragraph destroys the fact
   * boundaries the curator reads.
   */
  user: string[];
  /** Final answer: the last assistant message with text and no tool call. */
  assistant: string;
}

/**
 * Split the session into rounds — one round per user question — and keep the
 * last `recentTurns` of them.
 *
 * Rounds are segmented by DIRECT USER PROMPTS, not by `turn/end`: a harness
 * turn is one agent run, which background-job settles and user interrupts cut
 * at arbitrary points. Measured on this deployment's archived sessions, 12 of
 * 33 turns ended without their answer (it landed in the next turn), so
 * turn-marker segmentation would strand questions from their answers.
 *
 * A direct prompt opens a new round only when the previous round already has
 * its answer; prompts that arrive while the agent is still working (queued
 * follow-ups, a confirmation after an interruption) join the open round. The
 * round's answer is the last assistant message carrying text and no
 * `tool-call` block — everything with a tool call is mid-work narration
 * ("now I'll check X", "tests pass so far") and never an answer. Synthetic
 * user-role messages (time/runtime context, the skill catalog, AGENTS.md) are
 * the harness talking; they neither open a round nor enter one.
 *
 * @returns rounds in chronological order, at most `recentTurns` of them
 */
export function extractTurns(session: Session, recentTurns: number): TranscriptTurn[] {
  const events = sessionEvents(session);
  const rounds: TranscriptTurn[] = [];
  let current: TranscriptTurn | null = null;
  for (const event of events) {
    const carrier = event as unknown as {
      type?: string;
      data?: {
        source?: { kind?: string };
        content?: readonly { type: string; text?: string }[];
        message?: { content?: readonly { type: string; text?: string }[] };
      };
    };
    // Direct human prompt. Synthetic user-role messages (time/runtime context,
    // the skill catalog, AGENTS.md) are the harness talking, not the user.
    if (carrier.type === 'user/message') {
      if (carrier.data?.source?.kind !== 'user') continue;
      const text = textOf(carrier.data.content);
      if (!text) continue;
      if (!current || current.assistant) {
        current = { user: [], assistant: '' };
        rounds.push(current);
      }
      current.user.push(text);
      continue;
    }
    if (carrier.type === 'assistant/message' && current) {
      const blocks = carrier.data?.message?.content;
      if (!blocks) continue;
      // A step that called a tool is mid-work narration, not an answer.
      // Later qualifying steps overwrite it, so the last one wins.
      if (blocks.some((b) => b.type === 'tool-call')) continue;
      const text = textOf(blocks);
      if (text) current.assistant = text;
    }
  }
  return rounds.slice(-Math.max(1, recentTurns));
}

function textOf(blocks: readonly { type: string; text?: string }[] | undefined): string {
  if (!blocks) return '';
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join(' ')
    .trim();
}

/**
 * @returns bounded recent conversation as user/assistant pairs, tagged by source
 */
export function buildTranscript(session: Session, recentTurns: number, maxChars: number): string {
  const turns = extractTurns(session, recentTurns);
  if (turns.length > 0) {
    // Trim by whole turns, never by line: dropping leading lines would cut a
    // turn open and leave an ASSISTANT answer with no question above it, or
    // just a fragment of one.
    const blocks = turns.map((turn) => {
      const lines: string[] = [];
      // One line per message: a user who sent three prompts in one turn keeps
      // three separate USER lines, followed by the single ASSISTANT answer.
      for (const text of turn.user) lines.push(`USER: ${text}`);
      if (turn.assistant) lines.push(`ASSISTANT: ${turn.assistant}`);
      return lines.join('\n');
    });
    return clipTurns(blocks, maxChars);
  }
  // No turn markers available (older archives, synthetic sessions): fall back
  // to the derived-message projection, tagged so injected instructions are
  // still distinguishable from what the user typed.
  let messages: ReturnType<Session['deriveMessages']>;
  try {
    messages = session.deriveMessages();
  } catch {
    return '';
  }
  const limit = Math.max(1, Math.floor(recentTurns * 3));
  const tail = messages.slice(-limit) as unknown as readonly TranscriptMessage[];
  const lines: string[] = [];
  for (const msg of tail) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    const line = renderTranscriptLine(msg);
    if (line) lines.push(line);
  }
  return clipTranscript(lines, maxChars);
}

/**
 * Trim whole turns from the front until the rest fits, so a surviving turn is
 * never a fragment. The last turn alone may still be over budget; a single
 * over-long turn keeps its question and tails off, because the question is the
 * part that tells the curator who the user is.
 */
function clipTurns(blocks: string[], maxChars: number): string {
  if (maxChars <= 0) return blocks.join('\n');
  while (blocks.length > 1 && blocks.join('\n').length > maxChars) blocks.shift();
  const out = blocks.join('\n');
  if (out.length <= maxChars) return out;
  const cut = out.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf('\n');
  const kept = lastBreak > 0 ? cut.slice(0, lastBreak) : cut;
  return `${kept}\n…(truncated)`;
}

/**
 * Trim to the tail while keeping every surviving line labeled: a mid-line cut
 * ("SISTANT: …") reads as an unlabeled fact and loses its provenance.
 */
function clipTranscript(lines: string[], maxChars: number): string {
  if (maxChars <= 0) return lines.join('\n');
  while (lines.length > 1 && lines.join('\n').length > maxChars) lines.shift();
  const out = lines.join('\n');
  return out.length > maxChars ? out.slice(out.length - maxChars) : out;
}

/**
 * Parse the curator reply into plain facts (exported for testing).
 */
export function parseFacts(reply: unknown): string[] {
  const facts: string[] = [];
  let inFence = false;
  for (const raw of String(reply ?? '').split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    let line = raw.replace(/^[-*•\d.)\s]+/, '').trim();
    if (!line) continue;
    if (/^NONE$/i.test(line)) continue;
    if (line.length > 300) line = line.slice(0, 300);
    facts.push(line);
    if (facts.length >= 8) break;
  }
  return facts;
}
