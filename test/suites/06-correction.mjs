/**
 * Suite 06 — in-chat correction detection: strong/weak/negative patterns, the
 * directive extractor and the custom-pattern override.
 */
import { extractCorrectionDirective, isCorrection } from '../../dist/lib/correction.js';
import { check } from '../harness.mjs';

check('correction strong pattern triggers', isCorrection("don't do that, use the other way") === true);
check('correction strong I said triggers', isCorrection('I said use pnpm') === true);
check('correction weak + directive triggers', isCorrection('no, use pnpm instead') === true);
check('correction weak without directive suppressed', isCorrection('no, the sky') === true, 'the is a directive word');
check('correction weak bare no suppressed', isCorrection('no.') === false);
check('correction negative suppresses', isCorrection('no problem at all') === false);
check('correction negative actually-good suppresses', isCorrection('actually that looks great') === false);
check('correction plain text not detected', isCorrection('can you check the build log?') === false);
check('correction directive extracted', extractCorrectionDirective('no, use pnpm instead') === 'use pnpm instead');
check('correction directive I told you', extractCorrectionDirective('I told you to run the tests') === 'to run the tests');
check('correction custom pattern override', isCorrection("don't do that", { correctionStrongPatterns: ['never use x'] }) === false, 'strong defaults replaced by override');
check('correction custom pattern matches', isCorrection('never use x again', { correctionStrongPatterns: ['never use x'] }) === true);
