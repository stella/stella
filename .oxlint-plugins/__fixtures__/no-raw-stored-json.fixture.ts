// Passive regression fixture for `no-raw-stored-json/no-raw-stored-json`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses, the matching disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails CI. The
// allowed cases carry no disable, so a false positive would fail the
// fixture too.

declare const readStoredJson: (raw: string | null, schema: unknown) => unknown;
declare const localStorage: { getItem: (key: string) => string | null };
declare const sessionStorage: { getItem: (key: string) => string | null };
declare const window: {
  localStorage: { getItem: (key: string) => string | null };
  sessionStorage: { getItem: (key: string) => string | null };
};
declare const schema: unknown;
declare const sseEventData: string;
declare const storage: { getItem: (key: string) => string | null };

// MUST flag: direct call on localStorage. Also exercises the
// TSNonNullExpression peeling (`!` is required since getItem() returns
// `string | null`).
// oxlint-disable-next-line no-raw-stored-json/no-raw-stored-json, typescript/no-non-null-assertion
export const directLocal = () => JSON.parse(localStorage.getItem("k")!);

// MUST flag: direct call on sessionStorage.
// oxlint-disable-next-line no-raw-stored-json/no-raw-stored-json, typescript/no-non-null-assertion
export const directSession = () => JSON.parse(sessionStorage.getItem("k")!);

// MUST flag: a `?? "..."` fallback is looked through — the storage read is
// the left operand of the LogicalExpression. Block body kept (unrelated
// arrow-body-style suppressed) so the rule-under-test disable sits on the
// line directly above the JSON.parse call it targets.
// oxlint-disable-next-line arrow-body-style
export const directNullishFallback = () => {
  // oxlint-disable-next-line no-raw-stored-json/no-raw-stored-json
  return JSON.parse(localStorage.getItem("k") ?? "null");
};

// MUST flag: `?? "..."` fallback on a tracked variable.
export const variableNullishFallback = () => {
  const raw = sessionStorage.getItem("k");
  // oxlint-disable-next-line no-raw-stored-json/no-raw-stored-json
  return JSON.parse(raw ?? "null");
};

// MUST flag: variable assigned from a storage getItem() call, parsed later
// in the same function.
export const viaLocalVariable = () => {
  const raw = localStorage.getItem("k");
  if (!raw) {
    return null;
  }
  // oxlint-disable-next-line no-raw-stored-json/no-raw-stored-json
  return JSON.parse(raw);
};

// MUST flag: same pattern through window.sessionStorage — the property
// name (`sessionStorage`), not just the left-most identifier (`window`),
// must be checked in the member-expression chain.
export const viaSessionVariable = () => {
  const raw = window.sessionStorage.getItem("k");
  if (!raw) {
    return null;
  }
  // oxlint-disable-next-line no-raw-stored-json/no-raw-stored-json
  return JSON.parse(raw);
};

// MUST flag: a nested callback closes over a storage value declared by the
// component/helper that created it.
export const viaEnclosingFunctionVariable = () => {
  const raw = localStorage.getItem("k");
  return () => {
    // oxlint-disable-next-line no-raw-stored-json/no-raw-stored-json
    return JSON.parse(raw ?? "null");
  };
};

// Allowed: an inner declaration shadows the storage-sourced outer value.
export const shadowedEnclosingVariable = () => {
  const raw = localStorage.getItem("k");
  return () => {
    const raw = sseEventData;
    return JSON.parse(raw);
  };
};

// Allowed — the sanctioned helper, not JSON.parse.
export const viaHelper = () =>
  readStoredJson(localStorage.getItem("k"), schema);

// Allowed — not storage-sourced at all (e.g. an SSE payload).
export const notStorage = () => JSON.parse(sseEventData);

// Allowed — a variable not sourced from a storage .getItem() call.
export const unrelatedVariable = () => {
  const raw = sseEventData;
  return JSON.parse(raw);
};

// Allowed by design (heuristic limitation, not a type-aware analysis): a
// generic `Storage`-typed parameter chosen at runtime between local/session
// storage is not literally `localStorage`/`sessionStorage`, so it is not
// tracked.
export const genericStorageParam = () => {
  const raw = storage.getItem("k");
  return JSON.parse(raw ?? "null");
};

// Allowed by design (lexical, not whole-module): the storage variable is
// declared in one function and parsed in a different one.
let hoisted: string | null = null;
export const declareInOneFunction = () => {
  hoisted = localStorage.getItem("k");
};
export const parseInAnotherFunction = () => JSON.parse(hoisted ?? "null");
