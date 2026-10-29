/**
 * File exporter for the cordis logger — the missing sink.
 *
 * cordis' logger service buffers 1000 messages in memory and hands every one
 * to registered exporters; without an exporter nothing reaches disk. The host
 * only mounts a startup collector (levels.default = 2, warn/error, startup
 * failures only), so this plugin's info-level logs were invisible in every
 * deployment — forensic work meant aligning file mtimes with turn timestamps.
 *
 * This exporter writes the plugin's own log file under `<dshHome>/logs/`,
 * next to the host's startup logs. Appending (O_APPEND) keeps concurrent
 * sessions from interleaving mid-line; a single write per message keeps the
 * format stable without a formatter pipeline. Rotation is left to logrotate
 * or manual cleanup — the plugin's volume is low (a handful of lines per
 * learning run), and a size cap that silently drops records would defeat the
 * point.
 *
 * Config: `fileLogEnabled` (default true), `fileLogPath` (default
 * `<dshHome>/logs/persona-memory.log`). Set `fileLogEnabled: false` to rely
 * on the memory buffer alone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { Logger } from '@deepseek-ai/cordis';
import type { Context, Message } from '@deepseek-ai/cordis';

const LEVEL_NAMES: Record<number, string> = { 0: 'ERROR', 1: 'INFO', 2: 'WARN', 3: 'DEBUG' };

export interface FileLogConfig {
  fileLogEnabled: boolean;
  fileLogPath: string;
}

/** Default sink: next to the host's own startup logs, under the DSH home. */
export function defaultFileLogPath(): string {
  return path.join(dshHomePath(), 'logs', 'persona-memory.log');
}

/**
 * Format one structured record as a plain line. Text rendering goes through
 * cordis' own `Logger.format` so printf placeholders (%s/%d/%o…) resolve
 * exactly as they would on the official console exporter; this file only
 * wraps it with the timestamp + level header.
 */
function renderMessage(exporter: { formatters?: Record<string, (value: any, ex: never, msg: Message) => any> }, message: Message): string {
  const time = new Date(message.ts).toISOString();
  const level = LEVEL_NAMES[message.level] ?? `L${message.level}`;
  return `${time} ${level.padEnd(5)} [${message.name}] ${Logger.format(exporter as never, message)}`;
}

/**
 * Register the file exporter on the plugin's context.
 *
 * Fires-and-forgets appends: a failed write must never break the caller, so
 * errors are swallowed after being printed to stderr once per streak — the
 * message is also still in the logger's memory buffer for inspection.
 */
export function registerFileLogger(ctx: Context, cfg: FileLogConfig): void {
  if (!cfg.fileLogEnabled) return;
  const file = cfg.fileLogPath || defaultFileLogPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    // The memory buffer still works; report and continue without a sink.
    // eslint-disable-next-line no-console
    console.error(`[dsh-persona-memory] cannot create log dir ${path.dirname(file)}`);
    return;
  }
  let warnStreak = false;
  // A context without the exporter service (tests, exotic hosts) just keeps
  // the memory buffer — degrading beats throwing at registration time.
  if (typeof ctx.logger.exporter !== 'function') {
    // eslint-disable-next-line no-console
    console.error('[dsh-persona-memory] logger.exporter unavailable; file logging skipped');
    return;
  }
  const disposer = ctx.logger.exporter({
    levels: { default: 3 }, // DEBUG and up: this file is the plugin's record
    export(message) {
      try {
        fs.appendFileSync(file, `${renderMessage(this, message)}\n`, 'utf8');
        warnStreak = false;
      } catch {
        if (!warnStreak) {
          warnStreak = true;
          // eslint-disable-next-line no-console
          console.error(`[dsh-persona-memory] log write failed: ${file}`);
        }
        // Drop the record — a logging failure must never break a memory write.
      }
    },
  });
  // Unregister when the plugin unloads (hot reload, profile removal).
  // `ctx.effect` wants a factory that returns the disposer, not the instance.
  if (ctx.effect) ctx.effect(() => disposer);
  // One line through the same pipeline to prove the sink works at startup.
  ctx.logger.info('[dsh-persona-memory] file logging enabled: %s', file);
}
