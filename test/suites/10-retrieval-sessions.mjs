/**
 * Suite 10 — retrieval stack and session provenance:
 *   - vector index (fingerprint-incremental sync, cosine retrieval, RRF fusion)
 *   - `memory_search` hybrid vs file-only routing
 *   - derived-session exclusion (subagent/workflow children get no memory)
 */
import path from 'node:path';
import { createMemoryStore } from '../../dist/lib/memory-store.js';
import { createVectorIndex } from '../../dist/lib/vector-index.js';
import { fuseRanks, registerMemorySearchTool } from '../../dist/lib/memory-search-tool.js';
import { isDerivedSession, allowsInjection, sessionOf } from '../../dist/lib/sessions.js';
import { sessionCapturePolicy } from '../../dist/lib/learning.js';
import { BIG_LIMITS, check, testDir } from '../harness.mjs';

// 21. vector index: fingerprint-incremental sync + cosine retrieval + RRF fusion
// Deterministic fake embeddings: char-bigram bag vector, so word overlap drives
// cosine similarity without any real model.
function fakeEmbed(texts) {
  const DIM = 256;
  const rows = [];
  for (const text of texts) {
    const v = new Array(DIM).fill(0);
    const s = `\u0000${text}\u0000`;
    for (let i = 0; i < s.length - 1; i++) {
      let h = 7;
      for (const ch of s.slice(i, i + 2)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      v[h % DIM] += 1;
    }
    const norm = Math.sqrt(v.reduce((n, x) => n + x * x, 0)) || 1;
    rows.push(v.map((x) => x / norm));
  }
  return rows;
}
let embedCalls = 0;
const fakeProvider = {
  kind: 'remote',
  async embed(texts) {
    embedCalls++;
    return fakeEmbed(texts);
  },
};
const vecDir = path.join(testDir, 'vecindex');
const vstore = createMemoryStore({ dir: vecDir, limits: BIG_LIMITS });
await vstore.add('memory', 'godot physics enemy pathfinding');
await vstore.add('memory', 'coffee brewing temperature');
const vindex = createVectorIndex({ dir: vecDir, enabled: true, provider: fakeProvider });
check('vector index available', (await vindex.available()) === true);
const vhits = await vindex.search(vstore, 'godot enemy ai movement', 'all', 5);
check('vector search ranks semantic near-match first', vhits !== null && vhits[0]?.text.includes('godot physics'), JSON.stringify(vhits));
// fingerprint-incremental: adding a new entry only embeds the delta
embedCalls = 0;
await vstore.add('memory', 'unreal engine nav mesh');
const vhits2 = await vindex.search(vstore, 'godot enemy ai movement', 'all', 5);
check('vector search picks up new entry after incremental sync', vhits2 !== null && vhits2.some((h) => h.text.includes('unreal')), JSON.stringify(vhits2));
check('incremental sync embeds only the delta', embedCalls === 2, `calls=${embedCalls} (1 delta sync + 1 query)`);
// RRF fusion: entry in BOTH lists ranks above entries in only one
const ftsA = [
  { which: 'memory', created: '2026-01-01', text: 'both exact and semantic' },
  { which: 'memory', created: '2026-01-01', text: 'fts only exact' },
];
const vecA = [
  { which: 'memory', created: '2026-01-01', text: 'semantic only near' },
  { which: 'memory', created: '2026-01-01', text: 'both exact and semantic' },
];
const fused = fuseRanks(ftsA, vecA, 3);
check('rrf fusion boosts entries found by both engines', fused[0]?.text === 'both exact and semantic', JSON.stringify(fused));
check('rrf fusion dedupes and bounds', fused.length === 3);
const disabledVec = createVectorIndex({ dir: vecDir, enabled: false, provider: fakeProvider });
check('vector index disabled reports unavailable', (await disabledVec.available()) === false);
vindex.close();

// 22. memory_search tool: hybrid engine path with mocked vector index
let registeredSearchTool;
const searchCtx = {
  tools: { register: (tool) => { registeredSearchTool = tool; } },
  logger: { warn() {}, info() {} },
  llm: { stream: async function* () {} },
};
const searchStore = createMemoryStore({ dir: path.join(testDir, 'searchstore'), limits: BIG_LIMITS });
await searchStore.add('memory', 'rust borrow checker tips');
const mockFts = {
  async search(_store, query, which) {
    return [{ which, created: '2026-01-01', text: 'rust borrow checker tips' }];
  },
};
const mockVector = {
  async search() {
    return [{ which: 'memory', created: '2026-01-01', text: 'ownership memory safety' }];
  },
};
registerMemorySearchTool(searchCtx, searchStore, { searchMaxResults: 10 }, mockFts, mockVector);
const hybridResult = await registeredSearchTool.execute({ query: 'rust memory safety' }, undefined);
check('memory_search tool uses hybrid engine', hybridResult.engine === 'hybrid' && hybridResult.matches.length === 2, JSON.stringify(hybridResult));
// vector disabled → fts-only engine
registerMemorySearchTool(searchCtx, searchStore, { searchMaxResults: 10 }, mockFts, null);
const ftsOnly = await registeredSearchTool.execute({ query: 'rust' }, undefined);
check('memory_search tool falls back to fts engine', ftsOnly.engine === 'fts' && ftsOnly.matches[0]?.text.includes('borrow'), JSON.stringify(ftsOnly));

// 23. session provenance: derived sessions are excluded from memory capture
check('human session is not derived', isDerivedSession({ header: { cwd: 'E:/repo', agentPreset: 'standard' } }) === false);
check('missing or empty session is not derived', isDerivedSession(undefined) === false && isDerivedSession({}) === false);
check('subagent origin is derived', isDerivedSession({ header: { origin: 'subagent' } }) === true);
check('parent-linked session is derived', isDerivedSession({ header: { parentSession: 'session-parent' } }) === true);
check('delegated session by depth is derived', isDerivedSession({ header: { delegationDepth: 2 } }) === true);
check('injection allowed for human session', allowsInjection({ injectHumanOnly: true }, { header: {} }) === true);
check('injection skipped for derived session', allowsInjection({ injectHumanOnly: true }, { header: { origin: 'subagent' } }) === false);
check('injection stays on when human-only is off', allowsInjection({ injectHumanOnly: false }, { header: { origin: 'subagent' } }) === true);
check('sessionOf reads the assembly context', sessionOf({ agent: { session: { header: { origin: 'subagent' } } } })?.header?.origin === 'subagent');

const derivedPolicy = sessionCapturePolicy(
  { learnEnabled: true, learnHumanOnly: true },
  { header: { parentSession: 'p' } },
);
check('derived session skips learning', derivedPolicy.learning === false);
const humanPolicy = sessionCapturePolicy(
  { learnEnabled: true, learnHumanOnly: true },
  { header: { cwd: 'E:/repo' } },
);
check('human session keeps learning', humanPolicy.learning === true);
const permissivePolicy = sessionCapturePolicy(
  { learnEnabled: true, learnHumanOnly: false },
  { header: { origin: 'subagent' } },
);
check('capture policy can opt derived sessions back in', permissivePolicy.learning === true);
