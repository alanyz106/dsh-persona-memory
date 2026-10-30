/**
 * Failure memory (failures.md) — ported in spirit from pi-hermes-memory.
 *
 * Failures are structured entries in the SAME §-delimited format as MEMORY.md,
 * stored in `failures.md` (hermes filename). The text is built as:
 *   [<category>] <what went wrong> — Failed: <reason> — Corrected to: <fix>
 *
 * Recent failures (created within `failureMaxAgeDays`, at most
 * `failureMaxEntries`) are injected every request so the model learns from
 * past mistakes before repeating them.
 */
import { decodeEntry, type MemoryStore } from './memory-store.js';

/** hermes MemoryCategory set */
export const FAILURE_CATEGORIES = ['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk'];

export interface FailureOptions {
  category?: string;
  failureReason?: string;
  correctedTo?: string;
}

/** Separator between the structured segments of a failure line. */
const SEGMENT_DELIMITER = ' — ';
const REASON_PREFIX = 'Failed: ';
const CORRECTED_PREFIX = 'Corrected to: ';
const CATEGORY_PATTERN = /^\[([a-z-]+)\]\s*([\s\S]*)$/;

/**
 * Build a structured failure entry line (hermes buildFailureMemoryText).
 */
export function buildFailureText(content: string, opts: FailureOptions = {}): string {
  const category = FAILURE_CATEGORIES.includes(opts.category ?? '') ? opts.category : 'failure';
  const parts = [`[${category}] ${content.trim()}`];
  if (opts.failureReason?.trim()) parts.push(`${REASON_PREFIX}${opts.failureReason.trim()}`);
  if (opts.correctedTo?.trim()) parts.push(`${CORRECTED_PREFIX}${opts.correctedTo.trim()}`);
  return parts.join(SEGMENT_DELIMITER);
}

export interface ParsedFailure {
  category: string;
  content: string;
  failureReason?: string;
  correctedTo?: string;
}

/**
 * Split a failure line back into its structured fields.
 *
 * `buildFailureText` joins up to three segments with " — ", and both
 * `Failed: ` / `Corrected to: ` only ever appear at a segment boundary. Splitting
 * on every " — " and then walking the segments left-to-right lets a reason or fix
 * that itself contains " — " survive intact (it simply stays in the same segment).
 *
 * Lines that carry no structure (plain entries written before this format, or
 * `memory`/`user` entries) come back with just `content`.
 */
export function parseFailureText(text: string): ParsedFailure {
  const trimmed = text.trim();
  const categoryMatch = CATEGORY_PATTERN.exec(trimmed);
  const knownCategory = categoryMatch && FAILURE_CATEGORIES.includes(categoryMatch[1]);
  const category = knownCategory ? categoryMatch![1] : 'failure';
  const rest = knownCategory ? categoryMatch![2] : trimmed;

  const segments = rest.split(SEGMENT_DELIMITER);
  const contentParts: string[] = [];
  let failureReason: string | undefined;
  let correctedTo: string | undefined;
  // Which structured field is currently receiving text. Before the first
  // structured segment everything belongs to `content`; after that, any
  // unprefixed remainder continues the open field (so a reason that itself
  // contains " — " is preserved rather than leaking back into content).
  let open: 'content' | 'reason' | 'corrected' = 'content';

  for (const segment of segments) {
    if (segment.startsWith(CORRECTED_PREFIX)) {
      open = 'corrected';
      const value = segment.slice(CORRECTED_PREFIX.length).trim();
      if (value) correctedTo = correctedTo ? `${correctedTo}${SEGMENT_DELIMITER}${value}` : value;
      continue;
    }
    if (segment.startsWith(REASON_PREFIX)) {
      open = 'reason';
      const value = segment.slice(REASON_PREFIX.length).trim();
      if (value) failureReason = failureReason ? `${failureReason}${SEGMENT_DELIMITER}${value}` : value;
      continue;
    }
    if (open === 'content') contentParts.push(segment);
    else if (open === 'corrected') correctedTo = correctedTo ? `${correctedTo}${SEGMENT_DELIMITER}${segment}` : segment;
    else failureReason = failureReason ? `${failureReason}${SEGMENT_DELIMITER}${segment}` : segment;
  }

  return { category, content: contentParts.join(SEGMENT_DELIMITER).trim(), failureReason, correctedTo };
}

/** Options for {@link mergeFailureUpdate}. */
export interface FailureUpdateOptions extends FailureOptions {
  /** New body text; omitted keeps the existing one. */
  content?: string;
}

/**
 * Apply a partial update to an existing failure line.
 *
 * Fields left undefined keep their previous value, which is what makes
 * `update` non-destructive: a caller that only wants to fix the wording no
 * longer has to re-send `failure_reason` / `corrected_to`, and cannot drop them
 * by accident.
 *
 * An empty string is *not* the same as undefined: `''` explicitly clears the
 * field (so a wrong reason can be removed). `category` is treated as a plain
 * override and falls back to the existing category.
 */
export function mergeFailureUpdate(existingText: string, opts: FailureUpdateOptions = {}): string {
  const current = parseFailureText(existingText);
  const has = (value?: string) => typeof value === 'string';
  return buildFailureText(
    has(opts.content) ? opts.content! : current.content,
    {
      category: opts.category ?? current.category,
      failureReason: has(opts.failureReason) ? opts.failureReason : current.failureReason,
      correctedTo: has(opts.correctedTo) ? opts.correctedTo : current.correctedTo,
    },
  );
}

/**
 * Render recent failures for prompt injection (hermes renderFailureBlock +
 * getFailureEntries): entries created within the age window, newest first,
 * bullets, bounded by max entries.
 * @returns empty string when there is nothing recent
 */
export function renderRecentFailures(store: MemoryStore, cfg: { failureMaxAgeDays: number; failureMaxEntries: number }): string {
  const raw = store.readRawSync('failure');
  if (raw.length === 0) return '';
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - cfg.failureMaxAgeDays);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const recent = raw
    .map((line) => decodeEntry(line))
    .filter((e) => e.created >= cutoffStr)
    .sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0))
    .slice(0, cfg.failureMaxEntries);

  if (recent.length === 0) return '';
  const header = 'RECENT FAILURES & LESSONS (learn from these):';
  const bulletList = recent.map((e) => '• ' + e.text).join('\n');
  return `${header}\n${bulletList}`;
}
