// Passive regression fixture for `refusal-code/require-refusal-code`.
declare const HandlerError: new (props: Record<string, unknown>) => Error;
declare const errors: { HandlerError: typeof HandlerError };
declare const conflicted: boolean;
declare const status: number;
declare const props: { status: 409; message: string; code: string };

export const refusals = () => [
  // oxlint-disable-next-line refusal-code/require-refusal-code -- fixture: a codeless conflict loses its reason
  new HandlerError({ status: 409, message: "Already issued" }),
  // oxlint-disable-next-line refusal-code/require-refusal-code -- fixture: a hint without a code is still dropped
  new HandlerError({ status: 400, message: "Bad input", hint: "Fix it" }),
  // oxlint-disable-next-line refusal-code/require-refusal-code -- fixture: an explicit undefined code is no code
  new HandlerError({ status: 404, message: "Not found", code: undefined }),
  // oxlint-disable-next-line refusal-code/require-refusal-code -- fixture: either branch of the status is a refusal
  new HandlerError({ status: conflicted ? 409 : 422, message: "Refused" }),
  // oxlint-disable-next-line refusal-code/require-refusal-code -- fixture: a qualified constructor is the same class
  new errors.HandlerError({ status: 429, message: "Slow down" }),
  // expect-clean: refusal-code/require-refusal-code
  new HandlerError({ status: 409, code: "invoice_locked", message: "Locked" }),
  // expect-clean: refusal-code/require-refusal-code
  new HandlerError({ status: 401, message: "Sign in" }),
  // expect-clean: refusal-code/require-refusal-code
  new HandlerError({ status: 403, message: "Not allowed" }),
  // expect-clean: refusal-code/require-refusal-code
  new HandlerError({ status: 500, message: "Internal" }),
  // expect-clean: refusal-code/require-refusal-code
  new HandlerError({ status, message: "Passed through" }),
  // expect-clean: refusal-code/require-refusal-code
  new HandlerError({ ...props }),
];
