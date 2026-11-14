/**
 * Suite 01 — global store: read/search/add/update/delete/rewrite against the
 * real hermes file format (a copy of the user's files, never the originals).
 *
 * Also creates `shared.store`, which later suites (FTS, prompt fencing) reuse
 * instead of re-seeding their own MEMORY.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createMemoryStore, ENTRY_DELIMITER } from '../../dist/lib/memory-store.js';
import { BIG_LIMITS, check, hasRealFiles, shared, testDir } from '../harness.mjs';

const store = createMemoryStore({ dir: testDir, limits: BIG_LIMITS });
shared.store = store;

// 1. read both files against the REAL hermes format
const mem = await store.read('memory', 5000);
check('memory read parses entries', mem.entryCount > 0, `entries=${mem.entryCount} chars=${mem.charCount}`);
check('memory read returns content', mem.content.length > 0);
const user = await store.read('user', 8000);
check('user read parses entries', user.entryCount > 0, `entries=${user.entryCount}`);
// shared-content assertion only meaningful when the real Pi files were copied
check('user content mentions the shared profile marker', !hasRealFiles || user.content.includes('莲'), 'shared USER.md content visible');

// 2. search (self-contained: the real shared file may be consolidated live)
await store.add('memory', 'SMOKE-SEARCH-MARKER godot-ish content');
const hits = await store.search('SMOKE-SEARCH-MARKER', 'all', 10);
check('search finds added entry', hits.length > 0, `hits=${hits.length}`);
const noHits = await store.search('zzz-no-such-token-zzz', 'all', 10);
check('search misses nonsense', noHits.length === 0);

// 3. round-trip: add / update / delete
const before = (await store.stat('memory')).entryCount;
const added = await store.add('memory', 'SMOKE-TEST-ENTRY remember this fact');
check('add reports added', added.added && added.entryCount === before + 1, `entries=${added.entryCount}`);
const rawAfterAdd = fs.readFileSync(path.join(testDir, 'MEMORY.md'), 'utf8');
check('file is hermes-parseable after add', rawAfterAdd.split(ENTRY_DELIMITER).filter(Boolean).length === added.entryCount);

const upd = await store.update('memory', 'SMOKE-TEST-ENTRY', 'SMOKE-TEST-ENTRY updated fact');
check('update finds and replaces', upd.updated === true);
const rawAfterUpd = fs.readFileSync(path.join(testDir, 'MEMORY.md'), 'utf8');
check('update kept hermes comment format', /updated fact <!-- created=\d{4}-\d{2}-\d{2}, last=\d{4}-\d{2}-\d{2} -->/.test(rawAfterUpd));

const del = await store.remove('memory', 'SMOKE-TEST-ENTRY');
check('delete removes entry', del.deleted === true && del.entryCount === before);

// 4. rewrite with a hermes-format document
const doc = `fact one <!-- created=2026-01-01, last=2026-01-01 -->${ENTRY_DELIMITER}fact two <!-- created=2026-01-02, last=2026-01-02 -->`;
const rw = await store.rewrite('memory', doc);
check('rewrite parses hermes doc', rw.entryCount === 2, `entries=${rw.entryCount}`);
const back = await store.read('memory', 5000);
check('rewrite round-trip readable', back.entryCount === 2 && back.content.includes('fact one'));
const rawAfterRw = await store.readRawSync('memory');
check('rewrite keeps created/last metadata intact',
  rawAfterRw.includes('fact one <!-- created=2026-01-01, last=2026-01-01 -->'),
  JSON.stringify(rawAfterRw));

// 4b. rewrite with PLAIN content containing a stray delimiter glyph must stay
// ONE entry (regression: detection looked for the glyph anywhere, so ordinary
// content with one occurrence was misread as a hermes document and collapsed
// all memory into one unformatted entry with no metadata comment).
const stray = await store.rewrite('memory', 'plain fact about towers \u00a7 one stray glyph');
check('rewrite stray glyph stays single entry', stray.entryCount === 1, `entries=${stray.entryCount}`);
const strayBack = await store.read('memory', 5000);
check('rewrite stray glyph keeps metadata', strayBack.entryCount === 1 && /<!-- created=\d{4}-\d{2}-\d{2}/.test(await store.readRawSync('memory')), JSON.stringify(strayBack));

// 4c. rewrite with a hermes doc whose entries start with the delimiter glyph
const doc2 = `\u00a7lead fact one <!-- created=2026-01-01, last=2026-01-01 -->${ENTRY_DELIMITER}\u00a7lead fact two <!-- created=2026-01-02, last=2026-01-02 -->`;
const rw2 = await store.rewrite('memory', doc2);
check('rewrite hermes doc with leading glyph entries', rw2.entryCount === 2, `entries=${rw2.entryCount}`);
