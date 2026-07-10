// Forbid `JSON.parse()` directly on a localStorage/sessionStorage-sourced
// string. Persisted-storage shapes drift across releases (a renamed
// field, a stale key format, a value written by an older build); a raw
// `JSON.parse` trusts that shape, and a mismatch surfaces far away as an
// unrelated crash instead of falling back cleanly at the read boundary.
// Route these reads through `readStoredJson` (apps/web/src/lib/stored-json.ts),
// which parses with try/catch and validates the result against a Valibot
// schema, returning `null` on any failure.
//
// This is a lexical heuristic, not a type-aware or whole-module scope
// analysis: it tracks, within a single function, `.getItem(` calls whose
// object chain mentions the literal identifier `localStorage` or
// `sessionStorage` (direct call, `window.localStorage`, etc.), plus any
// variable declared directly from such a call in that same function. It
// does not follow a value through a generic `Storage`-typed parameter or
// a helper indirection layer (e.g. a `storage: Storage` parameter chosen
// at runtime between local/session storage) — those sites are outside
// the heuristic by design and are not expected to be flagged.
//
// Flags:
//   JSON.parse(localStorage.getItem("k"));
//   JSON.parse(localStorage.getItem("k") ?? "null");
//   const raw = localStorage.getItem("k");
//   /* ... */ JSON.parse(raw);
//   const raw = window.sessionStorage.getItem("k");
//   /* ... */ JSON.parse(raw ?? "null");
//
// Allows:
//   readStoredJson(localStorage.getItem("k"), schema);   // the sanctioned helper
//   JSON.parse(sseEventData);                             // not storage-sourced
//   const raw = someOtherThing(); JSON.parse(raw);        // not a getItem() call
//   function a() { const raw = localStorage.getItem("k"); }
//   function b() { JSON.parse(raw); }                     // different function: not tracked
//
// The helper module itself (apps/web/src/lib/stored-json.ts) is excluded
// via `oxlint.config.ts` `excludeFiles`, since it is the one place raw
// `JSON.parse` on a persisted string is intentional.

import { isIdentifier, unwrapExpression } from "./utils.ts";

const STORAGE_IDENTIFIERS = new Set(["localStorage", "sessionStorage"]);

// Peel a TSNonNullExpression on top of the shared TS-wrapper unwrapper, so
// `localStorage.getItem("k")!` is still recognized.
const peel = (node: unknown): unknown => {
  const unwrapped = unwrapExpression(node);
  if (
    typeof unwrapped === "object" &&
    unwrapped !== null &&
    (unwrapped as { type?: unknown }).type === "TSNonNullExpression"
  ) {
    return peel((unwrapped as { expression: unknown }).expression);
  }
  return unwrapped;
};

// True if the expression is literally (or ends in, for a member chain)
// `localStorage` or `sessionStorage`: matches the bare identifier,
// `window.localStorage`, `self.sessionStorage`, etc. Checks the property
// name at each level (not just the left-most object), so `window.
// sessionStorage` matches on `sessionStorage`, not on `window`.
const mentionsStorageIdentifier = (node: unknown): boolean => {
  const current = peel(node);
  if (isIdentifier(current)) {
    return STORAGE_IDENTIFIERS.has(current.name);
  }
  if (
    typeof current !== "object" ||
    current === null ||
    (current as { type?: unknown }).type !== "MemberExpression"
  ) {
    return false;
  }
  const member = current as { computed?: unknown; property: unknown };
  if (
    member.computed === false &&
    isIdentifier(member.property) &&
    STORAGE_IDENTIFIERS.has(member.property.name)
  ) {
    return true;
  }
  return mentionsStorageIdentifier((current as { object: unknown }).object);
};

// True for `<expr>.getItem(...)` where `<expr>`'s chain mentions
// localStorage/sessionStorage.
const isStorageGetItemCall = (node: unknown): boolean => {
  const current = peel(node);
  if (
    typeof current !== "object" ||
    current === null ||
    (current as { type?: unknown }).type !== "CallExpression"
  ) {
    return false;
  }
  const callee = (current as { callee: unknown }).callee;
  if (
    typeof callee !== "object" ||
    callee === null ||
    (callee as { type?: unknown }).type !== "MemberExpression" ||
    (callee as { computed?: unknown }).computed !== false ||
    !isIdentifier((callee as { property: unknown }).property, "getItem")
  ) {
    return false;
  }
  return mentionsStorageIdentifier((callee as { object: unknown }).object);
};

const isJsonParseCallee = (callee: unknown): boolean =>
  typeof callee === "object" &&
  callee !== null &&
  (callee as { type?: unknown }).type === "MemberExpression" &&
  (callee as { computed?: unknown }).computed === false &&
  isIdentifier((callee as { object: unknown }).object, "JSON") &&
  isIdentifier((callee as { property: unknown }).property, "parse");

export default {
  meta: { name: "no-raw-stored-json" },
  rules: {
    "no-raw-stored-json": {
      meta: {
        type: "problem",
        messages: {
          noRawStoredJson:
            "Do not JSON.parse() a localStorage/sessionStorage value " +
            "directly; a shape drift across releases surfaces as a " +
            "far-away crash. Use readStoredJson() from " +
            "'@/lib/stored-json' to parse and validate against a " +
            "Valibot schema, returning null on any failure.",
        },
      },
      create(context) {
        // Stack of per-function Sets of variable names assigned directly
        // from a storage `.getItem()` call. Index 0 covers module/top-level
        // scope (code outside any function).
        const storageVarStack: Set<string>[] = [new Set()];

        const currentScope = (): Set<string> =>
          storageVarStack.at(-1) ?? storageVarStack[0]!;

        const enterFunction = () => {
          storageVarStack.push(new Set());
        };
        const exitFunction = () => {
          if (storageVarStack.length > 1) {
            storageVarStack.pop();
          }
        };

        return {
          Program() {
            storageVarStack.length = 1;
            storageVarStack[0] = new Set();
          },
          FunctionDeclaration: enterFunction,
          "FunctionDeclaration:exit": exitFunction,
          FunctionExpression: enterFunction,
          "FunctionExpression:exit": exitFunction,
          ArrowFunctionExpression: enterFunction,
          "ArrowFunctionExpression:exit": exitFunction,

          VariableDeclarator(node) {
            if (
              node.id.type !== "Identifier" ||
              !isStorageGetItemCall(node.init)
            ) {
              return;
            }
            currentScope().add(node.id.name);
          },

          CallExpression(node) {
            if (!isJsonParseCallee(node.callee)) {
              return;
            }
            const arg = node.arguments[0];
            if (arg === undefined) {
              return;
            }
            // Look through a `?? "..."` / `|| "..."` fallback: the storage
            // read is the left operand (`JSON.parse(raw ?? "null")`).
            let candidate = peel(arg);
            while (
              typeof candidate === "object" &&
              candidate !== null &&
              (candidate as { type?: unknown }).type === "LogicalExpression"
            ) {
              candidate = peel((candidate as { left: unknown }).left);
            }
            const flagged =
              isStorageGetItemCall(candidate) ||
              (isIdentifier(candidate) && currentScope().has(candidate.name));
            if (flagged) {
              context.report({ node, messageId: "noRawStoredJson" });
            }
          },
        };
      },
    },
  },
};
