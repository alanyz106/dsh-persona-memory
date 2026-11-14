/**
 * Suite 07 — FTS5 mirror and CJK retrieval (the reason this fork exists).
 *
 * Stock unicode61 treats a whole Han run as one token, so Chinese SUBSTRING
 * queries matched nothing; the index therefore expands CJK queries to bigrams
 * and OR-joins terms.
 */
import { createFtsIndex, buildFtsQuery } from '../../dist/lib/fts.js';
import { check, shared, testDir } from '../harness.mjs';

const store = shared.store;
const fts = createFtsIndex({ dir: testDir, enabled: true });

await store.add('memory', 'fts-marker godot physics notes');
await store.add('user', 'fts-marker prefers tabs over spaces');
const ftsHits = await fts.search(store, 'fts-marker', 'all', 10);
check('fts mirrors entries from both stores', ftsHits !== null && ftsHits.length >= 2, JSON.stringify(ftsHits?.map((h) => h.which)));
const ftsFiltered = await fts.search(store, 'fts-marker', 'user', 10);
check('fts respects which filter', ftsFiltered !== null && ftsFiltered.length === 1 && ftsFiltered[0].which === 'user');
const ftsMiss = await fts.search(store, 'zzz-no-such-token-zzz', 'all', 10);
check('fts misses nonsense', ftsMiss !== null && ftsMiss.length === 0);
const ftsQuote = await fts.search(store, 'say "hi"', 'all', 10);
check('fts handles quotes safely', ftsQuote !== null);
check('fts query splits whitespace tokens into quoted phrases', buildFtsQuery('alpha beta') === '"alpha" OR "beta"');
check('fts query is null for punctuation-only input', buildFtsQuery(' — ') === null);

// Multi-keyword recall: whitespace-separated keywords are separate terms, not
// one contiguous phrase, so non-adjacent terms hit the same entry.
await store.add('memory', 'zeta-alpha hobby gardener zeta-omega on macOS');
const ftsMulti = await fts.search(store, 'zeta-alpha zeta-omega', 'all', 10);
check('fts multi-keyword matches non-adjacent tokens', ftsMulti !== null && ftsMulti.length === 1, JSON.stringify(ftsMulti?.map((h) => h.text)));
// Terms are OR-joined rather than AND-joined: CJK bigram expansion requires it
// (a query crossing a word boundary has bigrams that never occur in the text).
// Ranking expresses the partial match instead of exclusion: the entry matching
// MORE terms sorts first.
await store.add('memory', 'partial-probe both-terms-here');
await store.add('memory', 'partial-probe only-one');
const ftsRanked = await fts.search(store, 'partial-probe both-terms-here', 'all', 10);
check(
  'fts or-query ranks the fuller match first',
  ftsRanked !== null && ftsRanked.length >= 1 && ftsRanked[0].text === 'partial-probe both-terms-here',
  JSON.stringify(ftsRanked?.map((h) => h.text)),
);
const ftsAbsentMiss = await fts.search(store, 'zzz-absent-zzz zzz-absent-yyy', 'all', 10);
check('fts or-query misses when every term is absent', ftsAbsentMiss !== null && ftsAbsentMiss.length === 0);
const ftsAdjacent = await fts.search(store, 'hobby gardener', 'all', 10);
check('fts adjacent phrase still matches', ftsAdjacent !== null && ftsAdjacent.length === 1);
// Injection safety: an injected OR must become a literal quoted term, never an
// operator. The stored entries contain no zzz-absent, so no hit may contain it.
const ftsInjection = await fts.search(store, 'zeta-alpha" OR "zzz-absent', 'all', 10);
check(
  'fts keeps operators literal (injection safe)',
  ftsInjection !== null && ftsInjection.every((h) => !h.text.includes('zzz-absent')),
  JSON.stringify(ftsInjection?.map((h) => h.text)),
);
check(
  'fts query escapes injected quotes as data',
  buildFtsQuery('zeta-alpha" OR "zzz-absent') === '"zeta-alpha" OR "OR" OR "zzz-absent"',
  String(buildFtsQuery('zeta-alpha" OR "zzz-absent')),
);

// --- CJK retrieval (the reason this fork exists) -------------------------
await store.add('memory', '用户偏好使用 pnpm 作为包管理器');
await store.add('memory', '记忆插件需要文件优先加索引');
check('cjk substring query hits', (await fts.search(store, '包管理器', 'all', 10))?.some((h) => h.text.includes('包管理器')) === true);
check('cjk two-char query hits', (await fts.search(store, '索引', 'all', 10))?.some((h) => h.text.includes('索引')) === true);
check('cjk cross-boundary query hits', (await fts.search(store, '插件安装', 'all', 10))?.some((h) => h.text.includes('记忆插件')) === true);
check(
  'cjk query expands to bigrams',
  buildFtsQuery('包管理器') === '"包管" OR "管理" OR "理器"',
  String(buildFtsQuery('包管理器')),
);
check('cjk mixed query keeps latin word whole', (await fts.search(store, 'pnpm 包管理器', 'all', 10))?.some((h) => h.text.includes('pnpm')) === true);
check('cjk nonsense still misses', (await fts.search(store, '量子纠缠态', 'all', 10))?.length === 0);
const fallbackMulti = await store.search('zeta-alpha zeta-omega', 'all', 10);
check('substring fallback uses AND over terms', fallbackMulti.length === 1);
const fallbackMultiMiss = await store.search('zeta-alpha zzz-absent', 'all', 10);
check('substring fallback misses when one term is absent', fallbackMultiMiss.length === 0);

const ftsDisabled = createFtsIndex({ dir: testDir, enabled: false });
check('fts disabled reports unavailable', (await ftsDisabled.available()) === false);
check('fts disabled search falls back to null', (await ftsDisabled.search(store, 'fts-marker', 'all', 10)) === null);
// substring fallback still works when FTS returns null
const fallbackHits = await store.search('fts-marker', 'all', 10);
check('substring fallback still finds entries', fallbackHits.length >= 2);
fts.close(); // release the SQLite handle so the temp dir can be removed
