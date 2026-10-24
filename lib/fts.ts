/**
 * FTS5 memory mirror — the "Memory Search Sync / Extended Store" counterpart
 * of pi-hermes-memory: memory entries are mirrored into a SQLite FTS5 index
 * so `memory_search` gets token-level full-text relevance instead of a linear
 * substring scan over the markdown files.
 *
 * - Index lives at `<memoryDir>/.memory-index.sqlite` (global stores only;
 *   per-project stores stay substring-searched — they are small and per-repo).
 * - The `text` column is UNINDEXED and holds the entry verbatim; MATCH runs
 *   against `grams`, a CJK-bigram projection of that text. See
 *   `lib/cjk-tokenizer.ts` for why: FTS5's default unicode61 tokenizer treats a
 *   Han run as a single token, so Chinese substring queries matched nothing.
 * - Rebuild is cheap (files are small) and driven by file-mtime staleness, so
 *   any write path (tool, learning, correction, consolidation) is picked up on
 *   the next search without explicit invalidation hooks.
 * - `node:sqlite` is imported dynamically: if it is unavailable or the open
 *   fails, `available()` reports false and callers fall back to the substring
 *   scan. The plugin never hard-depends on SQLite.
 */
import fs from 'node:fs';
import path from 'node:path';
import { decodeEntry, type MemoryKind, type MemoryStore } from './memory-store.js';
import { bigramize, queryTerms, quoteTerm } from './cjk-tokenizer.js';

const WHICHES: MemoryKind[] = ['memory', 'user', 'failure'];

/**
 * Bumped whenever the FTS schema or the tokenization changes. A mismatch drops
 * the derived table and rebuilds it from the Markdown files, which remain the
 * only source of truth.
 *
 * v2: added the `grams` bigram column so CJK substrings are searchable
 *     (v1 searched the raw text with unicode61, which cannot match Chinese
 *     substrings at all).
 */
const FTS_SCHEMA_VERSION = 2;

export interface FtsSearchHit {
  which: string;
  created: string;
  text: string;
}

export interface FtsIndex {
  search(store: MemoryStore, query: string, which: MemoryKind | 'all', limit: number): Promise<FtsSearchHit[] | null>;
  available(): Promise<boolean>;
  close(): void;
}

export interface FtsIndexConfig {
  dir: string;
  enabled: boolean;
}

/**
 * Translate a user query into one FTS5 MATCH expression.
 *
 * Terms come from {@link queryTerms}: Han runs expand to character bigrams
 * (so `包管理器` matches a memory containing it), latin runs stay whole words.
 * Terms are joined with OR and ranked by FTS5's BM25, so a query that matches
 * more of its terms ranks higher while partial matches still surface.
 *
 * Every term is a quoted phrase with internal quotes doubled, so FTS5 syntax in
 * user input stays data and is never executable.
 *
 * @returns the MATCH expression, or null when the query carries no word tokens
 */
export function buildFtsQuery(query: string): string | null {
  const terms = queryTerms(query);
  if (terms.length === 0) return null;
  return terms.map(quoteTerm).join(' OR ');
}

export function createFtsIndex(config: FtsIndexConfig): FtsIndex {
  const dbPath = path.join(config.dir, '.memory-index.sqlite');
  let db: import('node:sqlite').DatabaseSync | null = null;
  /** file mtimes at last build */
  let builtMtimes: Record<string, number> = {};

  async function open(): Promise<import('node:sqlite').DatabaseSync | null> {
    if (!config.enabled) return null;
    if (db) return db;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      db = new DatabaseSync(dbPath);
      // Schema version gate: a stale derived table is dropped and rebuilt from
      // the Markdown files on the next search (builtMtimes is cleared too, so
      // ensureBuilt cannot consider an empty table "fresh").
      db.exec('CREATE TABLE IF NOT EXISTS memory_fts_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      const row = db.prepare('SELECT value FROM memory_fts_meta WHERE key = ?').get('schema_version') as
        | { value?: unknown }
        | undefined;
      if (!row || String(row.value) !== String(FTS_SCHEMA_VERSION)) {
        db.exec('DROP TABLE IF EXISTS memory_fts');
        db.prepare('INSERT OR REPLACE INTO memory_fts_meta (key, value) VALUES (?, ?)').run(
          'schema_version',
          String(FTS_SCHEMA_VERSION),
        );
        builtMtimes = {};
      }
      // `text` stays UNINDEXED and is returned verbatim to callers; only
      // `grams` (the CJK-bigram projection) participates in MATCH.
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
          which UNINDEXED,
          created UNINDEXED,
          text UNINDEXED,
          grams
        );
      `);
      return db;
    } catch (err) {
      db = null;
      return null;
    }
  }

  /** @returns true when the index is fresh */
  async function ensureBuilt(store: MemoryStore): Promise<boolean> {
    const handle = await open();
    if (!handle) return false;
    const mtimes: Record<string, number> = {};
    for (const which of WHICHES) {
      const file = store.fileFor(which);
      try {
        mtimes[file] = fs.statSync(file).mtimeMs;
      } catch {
        mtimes[file] = 0; // absent file
      }
    }
    const stale = Object.keys(mtimes).some((file) => mtimes[file] !== builtMtimes[file]);
    if (!stale && Object.keys(builtMtimes).length > 0) return true;
    try {
      handle.exec('DELETE FROM memory_fts');
      const insert = handle.prepare('INSERT INTO memory_fts (which, created, text, grams) VALUES (?, ?, ?, ?)');
      for (const which of WHICHES) {
        for (const raw of await store.listRaw(which)) {
          const decoded = decodeEntry(raw);
          if (!decoded.text) continue;
          insert.run(which, decoded.created, decoded.text, bigramize(decoded.text));
        }
      }
      builtMtimes = mtimes;
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * Search the FTS mirror. Returns null when the index is unavailable —
   * callers fall back to the substring scan.
   */
  async function search(store: MemoryStore, query: string, which: MemoryKind | 'all', limit: number): Promise<FtsSearchHit[] | null> {
    const fresh = await ensureBuilt(store);
    if (!fresh) return null;
    try {
      // MATCH targets the `grams` column only (the bigram projection); `text`
      // is returned verbatim for display. Terms are quoted so FTS5 syntax stays
      // data, and OR-joined so CJK bigram expansions degrade gracefully —
      // BM25 (`rank`) still puts the entries matching more terms on top.
      const phrase = buildFtsQuery(query);
      if (phrase === null) return [];
      const rows = which === 'all'
        ? db!.prepare('SELECT which, created, text FROM memory_fts WHERE grams MATCH ? ORDER BY rank LIMIT ?').all(phrase, limit)
        : db!.prepare('SELECT which, created, text FROM memory_fts WHERE grams MATCH ? AND which = ? ORDER BY rank LIMIT ?').all(phrase, which, limit);
      return (rows as Array<Record<string, unknown>>).map((r) => ({ which: String(r.which), created: String(r.created), text: String(r.text) }));
    } catch (err) {
      return null;
    }
  }

  async function available(): Promise<boolean> {
    return (await open()) !== null;
  }

  /** Close the index (releases the SQLite handle / file locks). */
  function close(): void {
    try {
      db?.close();
    } catch {
      // closing a broken handle must not throw
    }
    db = null;
    builtMtimes = {};
  }

  return { search, available, close };
}
