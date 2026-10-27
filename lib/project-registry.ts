/**
 * Project registry — where the admin page and the backup job find projects.
 *
 * Under the old model every project lived in one directory
 * (`<memoryDir>/projects-memory/<name>/`), so listing them was a readdir. Now
 * a project's memory lives INSIDE the repository (AGENTS.md + memory/), so
 * there is nothing to scan. This registry remembers which absolute roots we
 * have touched, keyed by a display name.
 *
 * It is a *cache of known roots*, never a source of truth: if a registered
 * root disappears, its memory is gone regardless of what the registry says
 * (`missing: true` is reported, the record is kept so a restored checkout is
 * found again). Every mutating admin route rejects roots that are not in the
 * registry, which is what keeps the loopback-exposed admin API from becoming
 * an arbitrary-file read/write endpoint.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS_FILE } from './project-memory.js';

export const REGISTRY_FILE = 'project-registry.json';
const REGISTRY_VERSION = 1;

export interface ProjectRecord {
  /** display name (project root basename, de-duplicated) */
  name: string;
  /** absolute project root */
  root: string;
  /** last time a session or the admin page touched it (YYYY-MM-DD) */
  lastSeen: string;
}

interface RegistryFile {
  version: number;
  projects: Record<string, ProjectRecord>;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function registryPath(memoryDir: string): string {
  return path.join(memoryDir, REGISTRY_FILE);
}

/**
 * Read the registry, tolerating a missing or corrupt file.
 */
export function readRegistry(memoryDir: string): ProjectRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(registryPath(memoryDir), 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const projects = (parsed as RegistryFile | undefined)?.projects;
  if (!projects || typeof projects !== 'object') return [];
  return Object.values(projects)
    .filter((r): r is ProjectRecord => typeof r?.root === 'string' && typeof r?.name === 'string')
    .sort((a, b) => a.name.localeCompare(b.name));
}

function writeRegistry(memoryDir: string, records: ProjectRecord[]): void {
  const file = registryPath(memoryDir);
  const payload: RegistryFile = { version: REGISTRY_VERSION, projects: {} };
  for (const record of records) payload.projects[record.name] = record;
  fs.mkdirSync(memoryDir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** Derive a display name from a root, appending a suffix on collision. */
function nameFor(root: string, records: ProjectRecord[]): string {
  const base = path.basename(root) || 'project';
  const taken = new Set(records.map((r) => r.name));
  const existing = records.find((r) => r.root === root);
  if (existing) return existing.name;
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Register (or refresh) one project root.
 *
 * @returns the record that represents `root`
 */
export function registerProject(memoryDir: string, root: string): ProjectRecord {
  const resolved = path.resolve(root);
  const records = readRegistry(memoryDir);
  const existing = records.find((r) => r.root === resolved);
  if (existing) {
    if (existing.lastSeen === today()) return existing;
    const updated = { ...existing, lastSeen: today() };
    writeRegistry(memoryDir, records.map((r) => (r.root === resolved ? updated : r)));
    return updated;
  }
  const record: ProjectRecord = { name: nameFor(resolved, records), root: resolved, lastSeen: today() };
  writeRegistry(memoryDir, [...records, record]);
  return record;
}

/**
 * Drop one project from the registry (its files stay on disk).
 */
export function unregisterProject(memoryDir: string, root: string): boolean {
  const resolved = path.resolve(root);
  const records = readRegistry(memoryDir);
  const next = records.filter((r) => r.root !== resolved);
  if (next.length === records.length) return false;
  writeRegistry(memoryDir, next);
  return true;
}

export interface RegisteredProject extends ProjectRecord {
  /** whether AGENTS.md still exists at the registered root */
  exists: boolean;
}

/**
 * Registry entries annotated with whether their memory still exists.
 */
export function listRegistered(memoryDir: string): RegisteredProject[] {
  return readRegistry(memoryDir).map((record) => ({
    ...record,
    exists: fs.existsSync(path.join(record.root, AGENTS_FILE)),
  }));
}

/**
 * Look a root up by registry name (the admin page only knows names).
 *
 * @returns the absolute root, or null when the name is unknown
 */
export function rootForName(memoryDir: string, name: string): string | null {
  return readRegistry(memoryDir).find((r) => r.name === name)?.root ?? null;
}
