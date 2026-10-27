/**
 * Git project-root detection.
 *
 * A "project" is a Git repository root, so every linked worktree shares one
 * identity (and therefore one AGENTS.md + memory/ directory). Detection is
 * pure filesystem probing — no `git` subprocess — because it runs on the
 * request path.
 *
 * Linked worktrees are the interesting case: their `.git` is a *file* holding
 * a `gitdir:` pointer to `<main>/.git/worktrees/<name>`, plus a `commondir`
 * file (or the conventional parent layout, for older Git). Both spellings are
 * followed back to the main repository root.
 *
 * Project memory itself (the AGENTS.md index and memory/ files) lives in
 * lib/project-memory.ts; this module only answers "which directory is the
 * project root".
 */
import fs from 'node:fs';
import path from 'node:path';

const repoRootCache = new Map<string, string | null>();

/**
 * Resolve the repository root shared by every linked worktree of `dir`'s repo
 * (mirrors `git rev-parse --git-common-dir` without spawning git). Null
 * outside a repository.
 */
export function findGitRepoRoot(dir: string): string | null {
  let current = path.resolve(dir);
  while (true) {
    const dotGit = path.join(current, '.git');
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = undefined;
    }
    if (stat?.isDirectory()) return current;
    if (stat?.isFile()) {
      const commonDir = resolveWorktreeCommonDir(current, dotGit);
      if (!commonDir) return current;
      return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveWorktreeCommonDir(worktreeRoot: string, dotGitFile: string): string | null {
  let pointer: string;
  try {
    pointer = fs.readFileSync(dotGitFile, 'utf-8');
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(pointer);
  if (!match) return null;
  const gitDir = path.resolve(worktreeRoot, match[1].trim());
  try {
    const commonDir = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf-8').trim();
    if (commonDir) return path.resolve(gitDir, commonDir);
  } catch {
    // not a linked worktree / older layout
  }
  const parent = path.dirname(gitDir);
  return path.basename(parent) === 'worktrees' ? path.dirname(parent) : null;
}
