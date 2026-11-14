/**
 * Suite 09 — store concurrency and byte compatibility with pi-hermes:
 *   - concurrent adds never clobber (single-lock read-modify-write)
 *   - overflow is REFUSED, never silently trimmed
 *   - serialization is byte-identical (no trailing newline, section separator)
 *   - the injected memory block is fenced against prompt injection
 */
import fs from 'node:fs';
import path from 'node:path';
import { createMemoryStore, ENTRY_DELIMITER } from '../../dist/lib/memory-store.js';
import { renderMemoryBlock } from '../../dist/lib/prompt.js';
import { check, shared, testDir } from '../harness.mjs';

// 16. concurrent adds never clobber (single-lock read-modify-write)
const concStore = createMemoryStore({ dir: path.join(testDir, 'conc') });
const [ca, cb] = await Promise.all([
  concStore.add('memory', 'CONC-A entry'),
  concStore.add('memory', 'CONC-B entry'),
]);
const concRead = await concStore.read('memory', 5000);
check('concurrent adds both land', ca.added && cb.added && concRead.entryCount === 2, `entries=${concRead.entryCount}`);
const concRaw = fs.readFileSync(path.join(testDir, 'conc', 'MEMORY.md'), 'utf8');
check('concurrent adds both persisted', concRaw.includes('CONC-A') && concRaw.includes('CONC-B'));

// 17. overflow refusal (hermes semantics: never grow past the limit)
// NB: every entry costs ~45 extra chars for its created/last metadata comment.
const tightStore = createMemoryStore({ dir: path.join(testDir, 'tight'), limits: { memory: 70 } });
const t1 = await tightStore.add('memory', 'this entry fits fine');
check('tight add under limit lands', t1.added === true, JSON.stringify(t1));
const t2 = await tightStore.add('memory', 'this entry is way too long and must be refused outright by the store');
check('tight add over limit refused', t2.added === false && t2.overflow === true, JSON.stringify(t2));
const tightRaw = fs.readFileSync(path.join(testDir, 'tight', 'MEMORY.md'), 'utf8');
check('refused add did not write', !tightRaw.includes('way too long'));
const t3 = await tightStore.update('memory', 'fits fine', 'this replacement is also way too long and must be refused too');
check('tight update over limit refused', t3.updated === false && t3.overflow === true, JSON.stringify(t3));
const t4 = await tightStore.rewrite('memory', 'short');
check('tight rewrite under limit lands', t4.rewritten === true, JSON.stringify(t4));

// 18. byte-compatible serialization (no trailing newline, pi-hermes saveToDisk)
const byteStore = createMemoryStore({ dir: path.join(testDir, 'bytes') });
await byteStore.add('memory', 'byte one');
await byteStore.add('memory', 'byte two');
const byteRaw = fs.readFileSync(path.join(testDir, 'bytes', 'MEMORY.md'), 'utf8');
const byteOneEnc = byteRaw.split(ENTRY_DELIMITER)[0];
const byteTwoEnc = byteRaw.split(ENTRY_DELIMITER)[1];
check('file has no trailing newline', !byteRaw.endsWith('\n'), JSON.stringify(byteRaw.slice(-12)));
check('file is exactly two entries joined by the separator', byteRaw === `${byteOneEnc}${ENTRY_DELIMITER}${byteTwoEnc}`, JSON.stringify(byteRaw));
check('serialized entries keep metadata', /^byte one <!-- created=\d{4}-\d{2}-\d{2}, last=\d{4}-\d{2}-\d{2} -->$/.test(byteOneEnc) && /^byte two <!-- created=\d{4}-\d{2}-\d{2}, last=\d{4}-\d{2}-\d{2} -->$/.test(byteTwoEnc));

// 20. prompt injection uses the memory-context fence (hermes fenceBlock)
const fenced = renderMemoryBlock(shared.store, { memoryCharLimit: 5000, userCharLimit: 5000 });
check('memory block is fenced against injection', fenced.startsWith('<memory-context>') && fenced.endsWith('</memory-context>') && fenced.includes('NOT new user input'));
check('empty store renders the empty hint unfenced', renderMemoryBlock(createMemoryStore({ dir: path.join(testDir, 'empty') }), { memoryCharLimit: 5000, userCharLimit: 5000 }).startsWith('_empty'));
