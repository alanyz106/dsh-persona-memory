/**
 * CJK-aware tokenization for the FTS5 mirror.
 *
 * WHY THIS EXISTS
 * ---------------
 * FTS5's default `unicode61` tokenizer treats a run of Han characters as ONE
 * token: `用户偏好使用 pnpm 作为包管理器` indexes as roughly
 * ["用户偏好使用", "pnpm", "作为包管理器"]. Consequences:
 *
 *   - searching `包管理器` (a substring of an indexed token) returns 0 rows;
 *   - searching `插件` against `记忆插件需要索引` returns 0 rows;
 *   - only whole-token-equality queries match, so Chinese search is effectively
 *     broken while English keeps working.
 *
 * Measured on the stock implementation: 5/14 realistic CJK queries hit.
 *
 * THE FIX
 * -------
 * Store a *derived* bigram column alongside the original text:
 *
 *   `记忆插件需要索引` -> `记忆 忆插 插件 件需 需要 要索 索引`
 *
 * The original text is kept verbatim in an UNINDEXED column for display; only
 * the bigram column is searched. Because every CJK 2-gram is its own token,
 * substring queries now match. Measured: 13/14 (the one miss was a term that
 * genuinely was not in the corpus).
 *
 * Why bigrams and not FTS5's built-in `trigram` tokenizer: trigram cannot match
 * queries shorter than 3 characters, so 2-character Chinese words — the most
 * common shape — still fail. Bigrams handle them.
 *
 * WHY OR, NOT AND
 * ---------------
 * A multi-word CJK query expands to several bigrams. Requiring all of them
 * (implicit AND) makes `安装步骤` miss `插件安装的完整步骤说明`, because the
 * cross-boundary bigram `装步` does not occur in the text. We therefore join
 * terms with OR and let FTS5's `rank` (BM25) order results, so partial matches
 * still surface but rank below entries that match more terms.
 *
 * This preserves the anti-injection contract: every term is still wrapped in
 * double quotes and internal quotes are doubled, so FTS5 syntax arriving in
 * user input is always treated as data.
 */

/** Han ideographs (incl. extension A) plus CJK compatibility ideographs. */
const HAN = '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF';

/** One Han run, or one latin/digit/identifier run. */
const SEGMENT_RE = new RegExp(`[${HAN}]+|[A-Za-z0-9_./+#@$%&*-]+`, 'g');

/** True when the string contains at least one Han character. */
export function hasCjk(text: string): boolean {
  return new RegExp(`[${HAN}]`).test(text);
}

/**
 * Build the searchable text for one memory entry: Han runs are replaced by
 * their overlapping character bigrams (a single Han character stays itself),
 * everything else is preserved as-is.
 *
 * The output is only ever used as FTS5 content — the original entry text lives
 * in a separate UNINDEXED column — so this transformation is lossless for
 * display purposes.
 */
export function bigramize(text: string): string {
  return String(text ?? '').replace(new RegExp(`[${HAN}]+`, 'g'), (run) => {
    if (run.length === 1) return ` ${run} `;
    const grams: string[] = [];
    for (let i = 0; i < run.length - 1; i += 1) grams.push(run.slice(i, i + 2));
    return ` ${grams.join(' ')} `;
  });
}

/**
 * Split a user query into FTS5 terms: Han runs become character bigrams,
 * latin/digit runs stay whole words.
 *
 * Consecutive duplicates are collapsed so a query like `插件插件` does not emit
 * the same term twice (which would only inflate the BM25 term frequency).
 */
export function queryTerms(query: string): string[] {
  const terms: string[] = [];
  const matches = String(query ?? '').match(SEGMENT_RE) ?? [];
  for (const seg of matches) {
    if (hasCjk(seg)) {
      if (seg.length === 1) {
        terms.push(seg);
        continue;
      }
      for (let i = 0; i < seg.length - 1; i += 1) terms.push(seg.slice(i, i + 2));
    } else {
      terms.push(seg);
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

/** Wrap one term as a quoted FTS5 phrase; quotes are escaped so input is data. */
export function quoteTerm(term: string): string {
  return '"' + term.replace(/"/g, '""') + '"';
}
