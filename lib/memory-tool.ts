/**
 * The `memory` tool: read / add / update / delete / rewrite the persistent
 * persona memory (MEMORY.md and USER.md). On-disk format is shared with
 * pi-hermes-memory (entries separated by `§`, metadata in HTML comments).
 */
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from './json-value.js';
import { scanContent } from './secret-scanner.js';
import type { MemoryStore } from './memory-store.js';
import type { Context } from '@deepseek-ai/cordis';

/**
 * One line per mutating tool call. With the file exporter attached these are
 * the audit trail for "who wrote this entry" — session id, action, store,
 * outcome, and a content prefix. Read-only actions are not logged: they do
 * not change memory and would triple the file's volume.
 */
function logWrite(
  ctx: Context,
  exec: ToolRunContext | undefined,
  action: string,
  which: string,
  result: Record<string, unknown>,
  preview: string,
): void {
  const sessionId = (exec as { agent?: { id?: string } } | undefined)?.agent?.id ?? 'unknown-session';
  const outcome = result.conflict
      ? 'conflict'
      : action === 'delete'
        ? (result.deleted ? 'deleted' : 'not-found')
        : action === 'rewrite'
          ? `entries=${result.entryCount}`
          : 'ok';
  ctx.logger.info(
    '[dsh-persona-memory] memory %s %s %s (%s): %s',
    action,
    which,
    sessionId,
    outcome,
    preview.replace(/\s+/g, ' ').slice(0, 80),
  );
}

export interface MemoryToolConfig {
  enableSecretScanning: boolean;
}

export function registerMemoryTool(
  ctx: Context,
  store: MemoryStore,
  config: MemoryToolConfig,
): void {
  ctx.tools.register(
    defineTool({
      name: 'memory',
      description:
        'Manage the persistent long-term persona memory that survives across sessions. ' +
        'Stores: `memory` (global facts, preferences, conventions, environment details), `user` ' +
        '(who the user is, their preferences and communication style). ' +
        'Cross-project lessons and durable rules belong in `memory`; the user\'s own always-on ' +
        'rules belong in STANDING.md, which only the user edits (`/standing`, not this tool). ' +
        'A lesson that only makes sense in THIS repository (its build, deploy, architecture, a bug ' +
        'specific to this codebase) does NOT go here: record it in this repository\'s project memory ' +
        'via `project_memory` (a `memory/pitfalls.md` topic and/or a resident rule). ' +
        'When the user corrects you, add the entry with the text starting with `用户纠正：` ' +
        '(keep the date in the text) — consolidation never merges those away. ' +
        'Actions: read (show current memory), add (append one entry), update (replace an entry ' +
        'whose text contains `match`), delete (remove an entry whose text contains `match`), ' +
        'rewrite (replace the whole file — use for consolidation). Entries are free-form single-line ' +
        'blocks; keep each one self-contained and dated in spirit. Never store credentials — writes are scanned.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['read', 'add', 'update', 'delete', 'rewrite'],
          description: 'What to do with the memory.',
        },
        which: {
          type: 'string',
          enum: ['memory', 'user'],
          description: 'Which store to touch. Default: memory. Repository-specific knowledge belongs in `project_memory`, not here.',
        },
        content: {
          type: 'string',
          description: 'Entry text (for add/update) or full document content (for rewrite).',
        },
        match: {
          type: 'string',
          description: 'Substring locating the entry to update or delete (case-insensitive, first match wins).',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          return [{ type: 'text', text: formatResult(value) }];
        },
      },
      async execute(args, exec) {
        const targetStore = store;
        const which = args.which ?? 'memory';
        if (which !== 'memory' && which !== 'user') {
          throw new HarnessError(
            `Unknown memory store "${which}" — use "memory" or "user"; repository-specific knowledge belongs in \`project_memory\`.`,
            'MEMORY_INVALID_WHICH',
          );
        }
        let result: Record<string, unknown>;
        switch (args.action) {
          case 'read':
            result = (await targetStore.read(which)) as unknown as Record<string, unknown>;
            break;
          case 'add': {
            const entry = requireText(args.content, 'add');
            rejectBlocked(entry, config);
            result = (await targetStore.add(which, entry)) as unknown as Record<string, unknown>;
            logWrite(ctx, exec, 'add', which, result, entry);
            break;
          }
          case 'update': {
            const match = requireText(args.match, 'update', 'match');
            const entry = requireText(args.content, 'update');
            rejectBlocked(entry, config);
            result = (await targetStore.update(which, match, entry)) as unknown as Record<string, unknown>;
            logWrite(ctx, exec, 'update', which, result, `${match} -> ${entry}`);
            break;
          }
          case 'delete': {
            const match = requireText(args.match, 'delete', 'match');
            result = (await targetStore.remove(which, match)) as unknown as Record<string, unknown>;
            logWrite(ctx, exec, 'delete', which, result, match);
            break;
          }
          case 'rewrite': {
            const content = requireText(args.content, 'rewrite');
            rejectBlocked(content, config);
            result = (await targetStore.rewrite(which, content)) as unknown as Record<string, unknown>;
            logWrite(ctx, exec, 'rewrite', which, result, content);
            break;
          }
          default:
            throw new HarnessError(`Unknown action "${String(args.action)}"`, 'MEMORY_INVALID_ACTION');
        }
        if (result.conflict) {
          throw new HarnessError(
            'Memory file changed externally during this update (e.g. Pi or a manual edit landed first) — nothing was overwritten. Re-run the action against the fresh content.',
            'MEMORY_WRITE_CONFLICT',
          );
        }
        return result as unknown as Record<string, JsonValue>;
      },
    }),
  );
}

function requireText(value: unknown, action: string, field = 'content'): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HarnessError(`memory action "${action}" requires a non-empty \`${field}\``, 'MEMORY_MISSING_ARGUMENT');
  }
  return value.trim();
}

function rejectBlocked(content: string, config: { enableSecretScanning: boolean }): void {
  if (!config.enableSecretScanning) return;
  const blocked = scanContent(content);
  if (blocked) {
    throw new HarnessError(`Memory write rejected: ${blocked}`, 'MEMORY_CONTENT_BLOCKED');
  }
}


function formatResult(value: unknown): string {
  const v = value as Record<string, unknown>;
  if (v.content !== undefined && v.added === undefined && v.updated === undefined && v.deleted === undefined && v.rewritten === undefined) {
    return String(v.content);
  }
  const whichStr = String(v.which ?? '');
  const file = `memory/${whichStr === 'user' ? 'USER.md' : 'MEMORY.md'}`;
  if (v.added) return `Saved to ${file}. Now ${v.entryCount} entries (${v.charCount} chars).`;
  if (v.updated !== undefined) {
    return v.updated
      ? `Updated ${file}. ${v.entryCount} entries, ${v.charCount} chars.`
      : `No entry in ${file} matched — nothing changed. Run read first to see exact text.`;
  }
  if (v.deleted !== undefined) {
    return v.deleted
      ? `Deleted from ${file}. ${v.entryCount} entries remain.`
      : `No entry in ${file} matched — nothing deleted.`;
  }
  if (v.rewritten) return `Rewrote ${file}: ${v.entryCount} entries, ${v.charCount} chars.`;
  return JSON.stringify(v);
}
