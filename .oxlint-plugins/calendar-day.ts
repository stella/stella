// Calendar days and schedule decisions come from their owners.
//
// `no-utc-user-day`: a user-facing "today" is the calendar day in the user's
// or organization's zone, read through `todayFor(zone)` from `@stll/time`. The
// UTC day is a different day for hours around local midnight, so these
// spellings of it are rejected where a person sees or acts on the day:
//   Temporal.Now.plainDateISO("UTC") (and plainDateTimeISO / zonedDateTimeISO)
//   Temporal.Now.instant().toZonedDateTimeISO("UTC")
//   todayFor("UTC")
//   <x>.toISOString().slice(0, 10) / .substring(0, 10) / .substr(0, 10)
//   <x>.toISOString().split("T")[0] / .split("T").at(0)
//   Temporal.Now.instant().toString().slice(0, 10)
//   <x>.getUTCDate() / getUTCDay() / getUTCMonth() / getUTCFullYear()
//
// `no-wall-clock-scheduler-decision`: a scheduler task decides on the slot it
// was due for (`ctx.dueAt`, a `DueSlot` built from the job's `nextRunAt`), not
// on the wall clock at the moment the runner got to it. A late tick otherwise
// sees the next day and skips or repeats the slot. Rejected in task modules:
//   new Date()   Date.now()   Temporal.Now.<any>()
//
// Existing sites are budgeted per file, enclosing function and spelling in
// scripts/calendar-day-ledger.json (no line numbers, a reason per row). A
// budget can only shrink: a hit beyond it fails, and so does a budget the code
// no longer reaches, until the row is lowered or removed. Regenerate with
// `bun scripts/calendar-day-ledger.ts --write`.

import type { ESTree } from "@oxlint/plugins";
import { eslintCompatPlugin } from "@oxlint/plugins";

import ledger from "../scripts/calendar-day-ledger.json" with { type: "json" };
import { createBudgetLedger } from "./budget-ledger.ts";
import {
  filenameForContext,
  isAstNode,
  isIdentifier,
  memberPropertyName,
  staticStringValue,
  unwrapExpression,
  type AstNode,
} from "./utils.ts";

const USER_DAY_RULE = "no-utc-user-day";
const SCHEDULER_RULE = "no-wall-clock-scheduler-decision";
const LEDGER_PATH = "scripts/calendar-day-ledger.json";

const { tracker: budgetTracker, staleMessage: STALE_MESSAGE } =
  createBudgetLedger(LEDGER_PATH, ledger);

const UTC_ZONE_NOW_METHODS = new Set([
  "plainDateISO",
  "plainDateTimeISO",
  "zonedDateTimeISO",
]);
const UTC_DAY_GETTERS = new Set([
  "getUTCDate",
  "getUTCDay",
  "getUTCFullYear",
  "getUTCMonth",
]);
const PREFIX_SLICERS = new Set(["slice", "substr", "substring"]);
const ISO_SERIALIZERS = new Set(["toISOString", "toJSON"]);

const memberCall = (
  node: unknown,
): { object: AstNode; method: string; args: unknown[] } | null => {
  const call = unwrapExpression(node);
  if (call?.type !== "CallExpression") {
    return null;
  }
  const callee = unwrapExpression(call.callee);
  if (callee?.type !== "MemberExpression") {
    return null;
  }
  const method = memberPropertyName(callee);
  const object = unwrapExpression(callee.object);
  if (method === null || object === null) {
    return null;
  }
  return {
    object,
    method,
    args: Array.isArray(call.arguments) ? call.arguments : [],
  };
};

/** `Temporal.Now` or `globalThis.Temporal.Now`. */
const isTemporalNow = (node: unknown): boolean => {
  const member = unwrapExpression(node);
  if (
    member?.type !== "MemberExpression" ||
    memberPropertyName(member) !== "Now"
  ) {
    return false;
  }
  const temporal = unwrapExpression(member.object);
  if (isIdentifier(temporal, "Temporal")) {
    return true;
  }
  return (
    temporal?.type === "MemberExpression" &&
    memberPropertyName(temporal) === "Temporal" &&
    isIdentifier(unwrapExpression(temporal.object), "globalThis")
  );
};

const numberValue = (node: unknown): number | null =>
  isAstNode(node) && node.type === "Literal" && typeof node.value === "number"
    ? node.value
    : null;

/** `Temporal.Now.instant()`. */
const isNowInstant = (node: unknown): boolean => {
  const call = memberCall(node);
  return call?.method === "instant" && isTemporalNow(call.object);
};

/** `<x>.toISOString()` / `.toJSON()` / `Temporal.Now.instant().toString()`. */
const isoTimestampSource = (node: unknown): string | null => {
  const call = memberCall(node);
  if (call === null) {
    return null;
  }
  if (ISO_SERIALIZERS.has(call.method)) {
    return `${call.method}()`;
  }
  if (call.method === "toString" && isNowInstant(call.object)) {
    return "Temporal.Now.instant().toString()";
  }
  return null;
};

/** The banned user-day spelling at a call, or null. */
const utcUserDayAtCall = (node: unknown): string | null => {
  if (!isAstNode(node)) {
    return null;
  }
  const call = memberCall(node);
  if (call === null) {
    const callee = unwrapExpression(node.callee);
    const args = Array.isArray(node.arguments) ? node.arguments : [];
    if (
      isIdentifier(callee, "todayFor") &&
      staticStringValue(args.at(0)) === "UTC"
    ) {
      return 'todayFor("UTC")';
    }
    return null;
  }
  if (
    UTC_ZONE_NOW_METHODS.has(call.method) &&
    isTemporalNow(call.object) &&
    staticStringValue(call.args.at(0)) === "UTC"
  ) {
    return `Temporal.Now.${call.method}("UTC")`;
  }
  if (
    call.method === "toZonedDateTimeISO" &&
    staticStringValue(call.args.at(0)) === "UTC" &&
    isNowInstant(call.object)
  ) {
    return 'Temporal.Now.instant().toZonedDateTimeISO("UTC")';
  }
  if (UTC_DAY_GETTERS.has(call.method) && call.args.length === 0) {
    return `${call.method}()`;
  }
  if (
    PREFIX_SLICERS.has(call.method) &&
    numberValue(call.args.at(0)) === 0 &&
    numberValue(call.args.at(1)) === 10
  ) {
    const source = isoTimestampSource(call.object);
    return source === null ? null : `${source}.${call.method}(0, 10)`;
  }
  if (call.method === "at" && numberValue(call.args.at(0)) === 0) {
    const split = memberCall(call.object);
    if (
      split?.method === "split" &&
      staticStringValue(split.args.at(0)) === "T"
    ) {
      const source = isoTimestampSource(split.object);
      return source === null ? null : `${source}.split("T").at(0)`;
    }
  }
  return null;
};

/** `<x>.toISOString().split("T")[0]`. */
const utcUserDayAtMember = (node: unknown): string | null => {
  if (
    !isAstNode(node) ||
    node.computed !== true ||
    numberValue(node.property) !== 0
  ) {
    return null;
  }
  const split = memberCall(node.object);
  if (
    split?.method !== "split" ||
    staticStringValue(split.args.at(0)) !== "T"
  ) {
    return null;
  }
  const source = isoTimestampSource(split.object);
  return source === null ? null : `${source}.split("T")[0]`;
};

/** The wall-clock read at a call or construction, or null. */
const wallClockRead = (node: unknown): string | null => {
  if (!isAstNode(node)) {
    return null;
  }
  const args = Array.isArray(node.arguments) ? node.arguments : [];
  if (node.type === "NewExpression") {
    return isIdentifier(unwrapExpression(node.callee), "Date") &&
      args.length === 0
      ? "new Date()"
      : null;
  }
  const call = memberCall(node);
  if (call === null) {
    return null;
  }
  if (call.method === "now" && isIdentifier(call.object, "Date")) {
    return "Date.now()";
  }
  if (isTemporalNow(call.object)) {
    return `Temporal.Now.${call.method}()`;
  }
  return null;
};

export default eslintCompatPlugin({
  meta: { name: "calendar-day" },
  rules: {
    "no-utc-user-day": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          utcDay:
            "`{{pattern}}` is the UTC calendar day, not the user's: use `todayFor(zone)` from @stll/time with the user's or organization's zone. Ledger key: {{key}}",
          stale: STALE_MESSAGE,
        },
      },
      createOnce(context) {
        const tracker = budgetTracker(USER_DAY_RULE);
        const check = (node: ESTree.Node, pattern: string | null) => {
          const report =
            pattern === null ? null : tracker.record(node, pattern, "utcDay");
          if (report !== null) {
            context.report({ node, ...report });
          }
        };
        return {
          before() {
            tracker.reset(filenameForContext(context));
          },
          CallExpression(node) {
            check(node, utcUserDayAtCall(node));
          },
          MemberExpression(node) {
            check(node, utcUserDayAtMember(node));
          },
          "Program:exit"(node) {
            for (const report of tracker.stale()) {
              context.report({ node, ...report });
            }
          },
        };
      },
    },
    "no-wall-clock-scheduler-decision": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          wallClock:
            "`{{pattern}}` reads the wall clock in a scheduler task: decide on `ctx.dueAt` (the slot the job was due for). Ledger key: {{key}}",
          stale: STALE_MESSAGE,
        },
      },
      createOnce(context) {
        const tracker = budgetTracker(SCHEDULER_RULE);
        const check = (node: ESTree.Node) => {
          const pattern = wallClockRead(node);
          const report =
            pattern === null
              ? null
              : tracker.record(node, pattern, "wallClock");
          if (report !== null) {
            context.report({ node, ...report });
          }
        };
        return {
          before() {
            tracker.reset(filenameForContext(context));
          },
          NewExpression(node) {
            check(node);
          },
          CallExpression(node) {
            check(node);
          },
          "Program:exit"(node) {
            for (const report of tracker.stale()) {
              context.report({ node, ...report });
            }
          },
        };
      },
    },
  },
});
