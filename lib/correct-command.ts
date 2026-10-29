/**
 * The `/correct` user command — an explicit correction of the model, stored as
 * a `[correction]` failure entry so it surfaces in the injected recent-failures
 * block and the model stops repeating the mistake.
 *
 * Deliberately NOT `/feedback`: that is the harness' own session-feedback
 * command ("Record feedback about this session", logged for telemetry and
 * never shown to a model). Consuming its `feedback/record` event made every
 * product remark — "the UI lags" — a model correction in failures.md, which is
 * exactly wrong. `/correct` states the intent in its own name and is the only
 * write path here besides in-chat pattern detection.
 *
 * Rate-limited by the same `correctionRateLimitTurns` counter as in-chat
 * detection? No — an explicit command is deliberate intent, so it always
 * saves. The rate limit exists to stop pattern false-positives from spamming
 * failures.md; a human typing /correct has already decided.
 */
import { saveCorrection } from './learning.js';
import type { LearningConfig } from './learning.js';
import type { MemoryStore } from './memory-store.js';
import type { Context } from '@deepseek-ai/cordis';
// Type-only namespace import: loads dsh-commands' `declare module` augmentation
// so `ctx.commands` resolves on the cordis Context (stripped at runtime).
import type * as _DshCommands from '@deepseek-ai/dsh-commands';

export function registerCorrectCommand(ctx: Context, store: MemoryStore, cfg: LearningConfig): void {
  ctx.commands.register({
    name: 'correct',
    description:
      'Tell the memory plugin the model got something wrong — saves a correction so future sessions avoid repeating it. Usage: /correct <what was wrong and what to do instead>',
    handler: async ({ rawInput }) => {
      const text = rawInput.trim();
      if (!text) {
        return {
          kind: 'error',
          text: 'Usage: /correct <what was wrong and what to do instead> — e.g. /correct 包管理器用 pnpm，不要用 npm',
        };
      }
      if (cfg.enableSecretScanning) {
        // saveCorrection scans too, but a dry pre-check lets us answer the
        // user directly instead of silently dropping the entry.
        const { scanContent } = await import('./secret-scanner.js');
        if (scanContent(text)) {
          return { kind: 'error', text: '内容未通过安全扫描（疑似凭据或提示注入），未保存。' };
        }
      }
      try {
        await saveCorrection(store, cfg, text);
        return {
          kind: 'success',
          text: `已记录纠正：${text}\n将注入后续会话的 failures 上下文，帮助模型避免重复该错误。`,
        };
      } catch (err) {
        return { kind: 'error', text: `纠正保存失败：${String(err).slice(0, 200)}` };
      }
    },
  });
}
