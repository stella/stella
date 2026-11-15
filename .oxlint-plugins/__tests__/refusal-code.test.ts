import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const PLUGIN = "refusal-code";
const RULE = "require-refusal-code";

const DECLARATIONS = [
  "declare const HandlerError: new (props: Record<string, unknown>) => Error;",
  "declare const props: { status: 409; message: string };",
  "declare const status: number;",
  "declare const busy: boolean;",
].join("\n");

describe.serial("refusal-code/require-refusal-code", () => {
  test("rejects a client refusal without a code", async () => {
    expect(
      await lintSingleRule(
        RULE,
        [
          DECLARATIONS,
          'export const a = new HandlerError({ status: 409, message: "No series", hint: "Create one" });',
          'export const b = new HandlerError({ status: 404, message: "Not found", code: undefined });',
          'export const c = new HandlerError({ status: busy ? 429 : 500, message: "Busy" });',
          'export const d = new HandlerError({ status: 422, message: "Unreadable" });',
        ].join("\n"),
        { plugin: PLUGIN },
      ),
    ).toEqual([5, 6, 7, 8]);
  });

  test("accepts coded refusals, status-shown refusals and unreadable props", async () => {
    expect(
      await lintSingleRule(
        RULE,
        [
          DECLARATIONS,
          'export const a = new HandlerError({ status: 409, code: "invoice_number_series_missing", message: "No series" });',
          'export const b = new HandlerError({ status: 401, message: "Sign in" });',
          'export const c = new HandlerError({ status: 403, message: "Not allowed" });',
          'export const d = new HandlerError({ status: 500, message: "Internal" });',
          'export const e = new HandlerError({ status, message: "Passed through" });',
          "export const f = new HandlerError({ ...props });",
          'export const g = new Error("not a refusal");',
        ].join("\n"),
        { plugin: PLUGIN },
      ),
    ).toEqual([]);
  });
});
