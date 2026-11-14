/**
 * Manual consolidation — the admin page's「整理记忆」button asks the session's
 * own LLM route to merge related entries, and commits ONLY when the result is
 * strictly smaller, fully parseable, and passes the content scanner (hermes's
 * "refreshed < current" safety rule). A failed consolidation never corrupts
 * memory. It never runs automatically: stores have no hard size cap, so
 * nothing forces a merge and old entries are never deleted behind the user's
 * back.
 *
 * The prompt never reasons about time: `created` is carried through only as
 * bookkeeping (the admin page's prune window reads it). Consolidation is
 * driven by subject matter — merge related entries, keep preferences and
 * `用户纠正：` entries intact, and drop anything that belongs to one repository.
 */
import { ENTRY_DELIMITER, decodeEntry, encodeEntry, type MemoryStore } from './memory-store.js';
import { callLlm, type LlmRoute } from './llm-helper.js';
import { scanContent } from './secret-scanner.js';
import type { Context } from '@deepseek-ai/cordis';

/** per-store consolidation in flight */
const inflight = new Set<string>();

export interface ConsolidationConfig {
  enableSecretScanning: boolean;
  consolidateTimeoutMs: number;
}

export interface ConsolidationResult {
  ran: boolean;
  reason?: string;
  beforeEntries?: number;
  afterEntries?: number;
  beforeChars?: number;
  afterChars?: number;
}

/**
 * Run one manual consolidation pass. Never throws; returns why it declined.
 */
export async function consolidateStore(
  ctx: Context,
  store: MemoryStore,
  route: LlmRoute,
  cfg: ConsolidationConfig,
  which: 'memory' | 'user',
): Promise<ConsolidationResult> {
  // Key the in-flight guard by the store's own file path + which, so the
  // global store and every project store consolidate independently.
  const key = `${store.fileFor(which)}:${which}`;
  if (inflight.has(key)) return { ran: false, reason: 'inflight' };
  inflight.add(key);
  try {
    const raw = await store.listRaw(which);
    if (raw.length === 0) return { ran: false, reason: 'empty' };
    const beforeChars = raw.join(ENTRY_DELIMITER).length;

    // The model sees entry TEXT only: dates/tags are never injected into a
    // prompt and never influence the merge. Metadata is re-attached locally.
    const texts = raw.map((line) => decodeEntry(line).text);
    if (texts.length < 2) return { ran: false, reason: 'too-few-entries' };
    const prompt = buildConsolidationPrompt(texts);
    const reply = await callLlm(ctx, route, CONSOLIDATION_SYSTEM_PROMPT, prompt, cfg.consolidateTimeoutMs);
    const entries = parseConsolidatedOutput(reply);
    const check = validateConsolidation(texts, entries, cfg);
    if (!check.ok) return { ran: false, reason: check.reason };

    const t = new Date().toISOString().slice(0, 10);
    const nextRaw = attachMetadata(check.entries, raw, t);
    await store.replaceEntries(which, nextRaw);
    ctx.logger.info(
      '[dsh-persona-memory] consolidated %s: %d → %d entries, %d → %d chars',
      which, texts.length, check.entries.length, beforeChars, nextRaw.join(ENTRY_DELIMITER).length,
    );
    return {
      ran: true,
      beforeEntries: texts.length,
      afterEntries: check.entries.length,
      beforeChars,
      afterChars: nextRaw.join(ENTRY_DELIMITER).length,
    };
  } catch (err) {
    ctx.logger.warn('[dsh-persona-memory] consolidation failed: %s', (err as Error | undefined)?.message ?? String(err));
    return { ran: false, reason: 'error' };
  } finally {
    inflight.delete(key);
  }
}

const CONSOLIDATION_SYSTEM_PROMPT = `You are a memory consolidator for a coding agent's persistent long-term memory.

The user asked to consolidate this memory store. Rewrite its entries:
- Merge entries that are about the same subject into one concise, self-contained entry.
- Preserve every user preference and correction. They have the highest priority and must never be dropped or weakened.
- Entries that begin with \`用户纠正：\` are corrections the user gave you. Never drop them or fold them into a general fact entry; keep each one as its own entry, with its original wording intact.
- Drop entries that only make sense inside one repository (build steps, deploy quirks, architecture notes, code conventions): that knowledge belongs to that repository's project memory, not to the global memory. Keep only what stays true across repositories.
- Remove entries that are superseded or contradicted by a newer entry.
- Do not invent facts, credentials, or data that are not present in the source entries.

Output ONLY a JSON object, no markdown fences, no commentary:
{"entries": ["<full single-line entry>", ...]}
- Each entry is plain text on a single line: do not add dates, tags, or metadata comments.
- Fewer, denser entries are better. Merging is expected; losing a preference or a \`用户纠正：\` entry is not.
- If nothing is worth keeping, output {"entries": []}.`;

/**
 * @param current raw entry lines
 */
export function buildConsolidationPrompt(current: string[]): string {
  return `Current entries:\n${current.join('\n')}`;
}

/**
 * Re-attach hermes metadata to text-only consolidation output: an entry whose
 * text is unchanged keeps its exact source line (created/last intact), while a
 * merged or rewritten entry is stamped with `today` because its origin is
 * ambiguous. Dates are never shown to the model or used as a merge signal.
 * (exported for tests)
 */
export function attachMetadata(entries: string[], raw: string[], today: string): string[] {
  return entries.map((text) => raw.find((line) => decodeEntry(line).text === text) ?? encodeEntry(text, today, today));
}

/**
 * Extract the JSON `{"entries": [...]}` array from the model reply
 * (exported for testing).
 */
export function parseConsolidatedOutput(reply: unknown): string[] | null {
  const text = String(reply ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: { entries?: unknown };
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as { entries?: unknown };
  } catch {
    return null;
  }
  const entries = parsed?.entries;
  if (!Array.isArray(entries)) return null;
  const cleaned = entries.map((e) => (typeof e === 'string' ? e.trim() : '')).filter(Boolean);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Safety gate before committing a consolidation (exported for testing).
 */
export function validateConsolidation(
  current: string[],
  next: string[] | null,
  cfg: { enableSecretScanning: boolean },
): { ok: true; entries: string[]; chars: number } | { ok: false; reason: string } {
  if (!next || next.length === 0) return { ok: false, reason: 'no-entries' };
  // Compare text-only sizes so stripping metadata cannot fake a shrink.
  const currentChars = current.map((entry) => decodeEntry(entry).text).join(ENTRY_DELIMITER).length;
  const newChars = next.map((entry) => decodeEntry(entry).text).join(ENTRY_DELIMITER).length;
  if (newChars >= currentChars) {
    return { ok: false, reason: `not-smaller (${newChars} >= ${currentChars})` };
  }
  for (const entry of next) {
    const decoded = decodeEntry(entry);
    if (!decoded.text) return { ok: false, reason: 'empty-entry' };
    if (cfg.enableSecretScanning) {
      const blocked = scanContent(entry);
      if (blocked) return { ok: false, reason: `blocked: ${blocked}` };
    }
  }
  return { ok: true, entries: next, chars: newChars };
}
