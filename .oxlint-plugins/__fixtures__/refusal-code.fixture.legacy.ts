// A budgeted site passes; a second site in the same function exceeds the
// ledger budget of one and fails.
declare const HandlerError: new (props: Record<string, unknown>) => Error;

export const legacyRefusals = () => [
  // expect-clean: refusal-code/require-refusal-code
  new HandlerError({ status: 409, message: "Budgeted" }),
  // oxlint-disable-next-line refusal-code/require-refusal-code -- fixture: an existing budget cannot grow
  new HandlerError({ status: 409, message: "Beyond the budget" }),
];
