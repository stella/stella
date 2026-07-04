// Passive regression fixture for the built-in `oxc/no-accumulating-spread`
// rule (registered in `oxlint.config.ts`; no custom plugin file — oxlint
// ships it natively).
//
// AGENTS.md: "Avoid spread in loop accumulators (use `.push()`)." Spreading
// an accumulator inside a loop or `.reduce()` callback is O(n^2): every
// iteration copies the whole accumulator so far instead of appending in
// place.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses, the matching disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails CI. The
// allowed cases carry no disable, so a false positive would fail the
// fixture too.

declare const items: number[];

// MUST flag: spreading the accumulator inside a `for...of` loop body.
// (oxc's disable-directive matching keys off the loop statement itself,
// not the accumulator declaration or the spread expression.)
export const forOfSpread = () => {
  let acc: number[] = [];
  // oxlint-disable-next-line oxc/no-accumulating-spread
  for (const x of items) {
    acc = [...acc, x];
  }
  return acc;
};

// MUST flag: spreading the accumulator inside a `while` loop body.
export const whileSpread = () => {
  let acc: number[] = [];
  let index = 0;
  // oxlint-disable-next-line oxc/no-accumulating-spread
  while (index < items.length) {
    acc = [...acc, items[index]];
    index += 1;
  }
  return acc;
};

// Allowed — `.push()` mutates the accumulator in place.
export const forOfPush = () => {
  const acc: number[] = [];
  for (const x of items) {
    acc.push(x);
  }
  return acc;
};

// Note: the `.reduce()` accumulator-spread case this rule also covers
// (`items.reduce((acc, x) => [...acc, x], [])`) is not exercised here
// because `unicorn/no-array-reduce` already forbids `.reduce()` outright
// repo-wide, so that call shape cannot appear in product code regardless.

// Allowed — spreading two unrelated arrays outside a loop is not
// accumulation.
declare const left: number[];
declare const right: number[];
export const oneShotSpread = () => [...left, ...right];
