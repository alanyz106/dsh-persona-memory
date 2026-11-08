/**
 * Suite 16 — `/correct` command: explicit correction entry (immediate, no rate
 * limit), free-form composer hint, secret refusal, and the decoupling from the
 * harness' own `/feedback` event.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createMemoryStore } from '../../dist/lib/memory-store.js';
import { registerCorrectCommand } from '../../dist/lib/correct-command.js';
import { registerLifecycleHooks } from '../../dist/lib/learning.js';
import { BIG_LIMITS, check, testDir } from '../harness.mjs';

{
  const registered = [];
  const cmdCtx = {
    commands: { register: (def) => registered.push(def) },
    logger: { info() {}, warn() {} },
  };
  const corrStore = createMemoryStore({ dir: path.join(testDir, 'correct'), limits: BIG_LIMITS });
  const corrCfg = { enableSecretScanning: true, correctionDetection: true, correctionHumanOnly: true };
  registerCorrectCommand(cmdCtx, corrStore, corrCfg);
  check('/correct registers exactly one command', registered.length === 1 && registered[0].name === 'correct');
  // The Web composer only turns a menu pick / Tab into a command chip with the
  // caret left in the draft when the descriptor declares free-form input;
  // without it the pick runs the bare command and the user can never reach the
  // text field.
  check('/correct declares a free-form input hint (menu pick fills the draft)',
    typeof registered[0].input?.hint === 'string' && registered[0].input.hint.length > 0);

  const run = async (input) => await registered[0].handler({ rawInput: input });

  const empty = await run('   ');
  check('/correct without text answers usage', empty.kind === 'error' && /Usage: \/correct/.test(empty.text));

  const ok = await run('包管理器用 pnpm，不要用 npm');
  check('/correct saves a correction entry', ok.kind === 'success', ok.text);
  const raw = fs.readFileSync(path.join(testDir, 'correct', 'failures.md'), 'utf8');
  check('the correction lands in failures.md as a correction entry', /\[correction\] 包管理器用 pnpm/.test(raw), raw.slice(0, 120));

  const dup = await run('包管理器用 pnpm，不要用 npm');
  check('/correct dedupes identical text', dup.kind === 'success');

  const secret = await run('my key is sk-abcDEF0123456789abcdef0123456789 keep it');
  check('/correct refuses scanner-blocked content', secret.kind === 'error' && /安全扫描/.test(secret.text));
  const raw2 = fs.readFileSync(path.join(testDir, 'correct', 'failures.md'), 'utf8');
  check('the refused secret never touched failures.md', !raw2.includes('sk-abcDEF'));

  // the harness /feedback must no longer trigger corrections: feed its event
  // through the lifecycle hook and confirm failures.md stays untouched
  const fbStore = createMemoryStore({ dir: path.join(testDir, 'fb'), limits: BIG_LIMITS });
  const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
  const fbCtx = { logger: noopLog, on(_n, cb) { fbCtx.handler = cb; } };
  registerLifecycleHooks(fbCtx, fbStore, {
    enableSecretScanning: true, correctionDetection: true, correctionPatternDetection: true,
    correctionHumanOnly: true, correctionRateLimitTurns: 3,
    learnEnabled: false, learnHumanOnly: true, learnIntervalTurns: 10,
    learnRecentTurns: 2, learnMaxChars: 6000, learnTimeoutMs: 5000,
    learnProjectContext: false, learnProjectContextCharLimit: 1500,
    memoryCharLimit: 1_000_000, autoConsolidate: false,
  });
  const fbSession = { id: 'fb-session', header: {}, events: [], deriveMessages: () => [] };
  fbCtx.handler(fbSession, { type: 'feedback/record', data: { text: '界面有点卡顿，希望优化' } });
  await new Promise((r) => setTimeout(r, 100));
  check('the official /feedback event no longer writes corrections',
    !fs.existsSync(path.join(testDir, 'fb', 'failures.md'))
    || fs.readFileSync(path.join(testDir, 'fb', 'failures.md'), 'utf8').trim() === '');
}
