// Passive regression fixture for `no-serial-lint-case`.
//
// Each `oxlint-disable-next-line` suppresses a case the rule MUST flag; if the
// rule regresses, the unused directive fails the fixture harness.

declare const lintSingleRule: (source: string) => Promise<readonly string[]>;
declare const format: (source: string) => Promise<string>;
declare const cases: readonly string[];

export const serialCases = async () => {
  for (const source of cases) {
    // oxlint-disable-next-line no-serial-lint-case/no-serial-lint-case
    await lintSingleRule(source);
  }
  const queue = [...cases];
  for (let source = queue.pop(); source !== undefined; source = queue.pop()) {
    // oxlint-disable-next-line no-serial-lint-case/no-serial-lint-case
    await lintSingleRule(source);
  }
};

export const togetherCases = async () => {
  // expect-clean: no-serial-lint-case/no-serial-lint-case
  await Promise.all(cases.map(async (source) => lintSingleRule(source)));
  // expect-clean: no-serial-lint-case/no-serial-lint-case
  await lintSingleRule("one case outside a loop");
  for (const source of cases) {
    // expect-clean: no-serial-lint-case/no-serial-lint-case
    await format(source);
  }
  // A loop that only builds callbacks starts no lint run per iteration.
  const pending: (() => Promise<readonly string[]>)[] = [];
  for (const source of cases) {
    // expect-clean: no-serial-lint-case/no-serial-lint-case
    pending.push(async () => await lintSingleRule(source));
  }
  return pending;
};
