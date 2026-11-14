/**
 * Suite 09 — store concurrency and byte compatibility with pi-hermes:
 *   - concurrent adds never clobber (single-lock read-modify-write)
 *   - the store has no hard cap; injection is a NEWEST-first window
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
const concRead = await concStore.read('memory');
check('concurrent adds both land', ca.added && cb.added && concRead.entryCount === 2, `entries=${concRead.entryCount}`);
const concRaw = fs.readFileSync(path.join(testDir, 'conc', 'MEMORY.md'), 'utf8');
check('concurrent adds both persisted', concRaw.includes('CONC-A') && concRaw.includes('CONC-B'));

// 17. no hard size cap; injection keeps the newest complete entries
const tailStore = createMemoryStore({ dir: path.join(testDir, 'tail') });
await tailStore.add('memory', 'OLD-ENTRY ' + 'o'.repeat(120));
await tailStore.add('memory', 'MID-ENTRY ' + 'm'.repeat(120));
await tailStore.add('memory', 'NEW-ENTRY ' + 'n'.repeat(120));
const fullTail = await tailStore.read('memory');
check('store grows past the injection budget without refusing writes',
  fullTail.entryCount === 3, `entries=${fullTail.entryCount}`);
const win = tailStore.windowSync('memory', 150);
check('injection window keeps only the newest entry that fits',
  win.shownCount === 1 && win.omittedCount === 2, JSON.stringify({ shown: win.shownCount, omitted: win.omittedCount }));
check('window content is a complete entry, not a cut string',
  win.content.startsWith('NEW-ENTRY ') && !win.content.includes('MID-ENTRY') && !win.content.includes('OLD-ENTRY') && win.content.endsWith('n'.repeat(120)),
  win.content.slice(-12));
const wholeStore = tailStore.windowSync('memory', 0);
check('budget 0 means the whole store', wholeStore.shownCount === 3 && wholeStore.omittedCount === 0);
const winBlock = renderMemoryBlock(tailStore, { memoryCharLimit: 150, userCharLimit: 5000 });
check('injected block warns BEFORE the entries that older ones are missing',
  winBlock.indexOf('条未注入') > -1 && winBlock.indexOf('条未注入') < winBlock.indexOf('NEW-ENTRY') && winBlock.includes('memory_search'),
  winBlock.split('\n').filter((l) => l.includes('未注入') || l.includes('NEW-ENTRY')).join(' | '));
check('injected block omits the older entries entirely',
  !winBlock.includes('OLD-ENTRY') && !winBlock.includes('MID-ENTRY'));

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
