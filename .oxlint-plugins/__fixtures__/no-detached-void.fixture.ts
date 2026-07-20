// Passive regression fixture for `no-detached-void/no-detached-void`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses, the matching disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails CI. The
// allowed cases carry no disable, so a false positive would fail the fixture
// too.

declare const somePromise: () => Promise<void>;
declare const save: () => Promise<void>;

// MUST flag: void of a promise-returning call.
export const detachCall = () => {
  // oxlint-disable-next-line no-detached-void/no-detached-void
  void somePromise();
};

// MUST flag: void of an async IIFE.
export const detachIife = () => {
  // oxlint-disable-next-line no-detached-void/no-detached-void
  void (async () => {
    await save();
  })();
};

// MUST flag: void of a literal (the operator is banned regardless of operand).
export const voidLiteral = () => {
  // oxlint-disable-next-line no-detached-void/no-detached-void
  void 0;
};

// Allowed — the `void` TYPE keyword is a different AST node and must not be
// flagged. A false positive here (no disable present) would fail the fixture.
export const returnsVoid: () => void = () => undefined;
export const awaitsVoid = async (): Promise<void> => {
  await save();
};
export type VoidReturning = (value: string) => void;
