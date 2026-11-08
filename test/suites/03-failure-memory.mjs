/**
 * Suite 03 — failure memory (`failures.md`): structured lines, dedupe, partial
 * updates that must not drop fields, and the age/count window used by
 * per-request injection.
 *
 * Reuses `shared.store` (created by suite 01) so this file exercises the same
 * MEMORY.md/failures.md pair the rest of the run uses.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildFailureText, renderRecentFailures, parseFailureText, mergeFailureUpdate } from '../../dist/lib/failures.js';
import { check, shared, testDir } from '../harness.mjs';

const store = shared.store;

// 11. failure memory (failures.md)
check('failure text builds structured line', buildFailureText('deployed to prod', { category: 'correction', failureReason: 'forgot to run tests', correctedTo: 'run tests first' }) === '[correction] deployed to prod — Failed: forgot to run tests — Corrected to: run tests first');
check('failure text defaults unknown category to failure', buildFailureText('x', { category: 'bogus' }) === '[failure] x');
const f1 = await store.add('failure', buildFailureText('build failed', { failureReason: 'missing import' }), { dedupe: true });
check('failure add stores in failures.md', f1.added === true && f1.entryCount === 1 && fs.existsSync(path.join(testDir, 'failures.md')));
const f2 = await store.add('failure', buildFailureText('build failed', { failureReason: 'missing import' }), { dedupe: true });
check('failure add dedupes exact text', f2.added === false && f2.duplicate === true);
const f3 = await store.add('failure', buildFailureText('different failure', { category: 'tool-quirk' }), { dedupe: true });
check('failure add second entry', f3.added === true && f3.entryCount === 2);
const fSearch = await store.search('build failed', 'failure', 10);
check('failure searchable', fSearch.length === 1 && fSearch[0].which === 'failure');

// 11b. failure structured fields survive a partial update (regression: `update`
// used to rebuild the line from `content` alone, dropping Failed:/Corrected to:)
check('parse recovers all three fields',
  JSON.stringify(parseFailureText(buildFailureText('bad deploy', { category: 'correction', failureReason: 'skipped tests', correctedTo: 'run tests first' })))
  === JSON.stringify({ category: 'correction', content: 'bad deploy', failureReason: 'skipped tests', correctedTo: 'run tests first' }));
check('parse tolerates plain lines', JSON.stringify(parseFailureText('just a plain fact'))
  === JSON.stringify({ category: 'failure', content: 'just a plain fact', failureReason: undefined, correctedTo: undefined }));

// a reason that itself contains the segment delimiter must stay in the reason
const tricky = buildFailureText('tricky', { failureReason: 'a — b', correctedTo: 'do c' });
check('update keeps reason containing the delimiter',
  parseFailureText(mergeFailureUpdate(tricky, { content: 'tricky 2' })).failureReason === 'a — b');

// partial update: only content changes, reason + fix are preserved
const merged = mergeFailureUpdate(tricky, { content: 'tricky 2' });
check('partial update preserves reason and fix',
  merged === '[failure] tricky 2 — Failed: a — b — Corrected to: do c', merged);

// omitted vs empty string: "" explicitly clears a field
check('empty string clears corrected_to',
  mergeFailureUpdate(tricky, { correctedTo: '' }) === '[failure] tricky — Failed: a — b', mergeFailureUpdate(tricky, { correctedTo: '' }));

// store-level round trip through the real failures.md
await store.add('failure', buildFailureText('STORE-UPDATE-PROBE', { category: 'insight', failureReason: 'orig reason', correctedTo: 'orig fix' }), { dedupe: true });
const foundProbe = await store.findEntry('failure', 'STORE-UPDATE-PROBE');
check('findEntry returns the existing entry', typeof foundProbe === 'string' && foundProbe.includes('orig reason'));
await store.update('failure', 'STORE-UPDATE-PROBE', mergeFailureUpdate(foundProbe, { content: 'STORE-UPDATE-PROBE rewording' }));
const afterProbe = await store.findEntry('failure', 'STORE-UPDATE-PROBE');
check('store update kept failed/corrected fields',
  afterProbe.includes('[insight] STORE-UPDATE-PROBE rewording') && afterProbe.includes('Failed: orig reason') && afterProbe.includes('Corrected to: orig fix'), afterProbe);

// age filter: inject an old failure directly, verify it is excluded from the recent block
const oldDate = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString().split('T')[0];
const recent = renderRecentFailures(store, { failureMaxAgeDays: 7, failureMaxEntries: 5 });
check('recent failures rendered', recent.startsWith('RECENT FAILURES & LESSONS') && recent.includes('build failed'));
fs.appendFileSync(path.join(testDir, 'failures.md'), `\n§\nold stale failure <!-- created=${oldDate}, last=${oldDate} -->\n`);
const filtered = renderRecentFailures(store, { failureMaxAgeDays: 7, failureMaxEntries: 5 });
check('recent failures exclude stale by created date', !filtered.includes('old stale failure'));
const capped = renderRecentFailures(store, { failureMaxAgeDays: 7, failureMaxEntries: 1 });
check('recent failures cap by max entries', (capped.match(/• /g) || []).length === 1);
fs.writeFileSync(path.join(testDir, 'failures.md'), '');
check('recent failures empty when no entries', renderRecentFailures(store, { failureMaxAgeDays: 7, failureMaxEntries: 5 }) === '');
