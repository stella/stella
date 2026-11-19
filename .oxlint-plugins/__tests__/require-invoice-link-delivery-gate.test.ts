import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "require-invoice-link-delivery-gate";
const sourcePath = "apps/api/src/handlers/invoice-links/view.ts";
const lint = async (source: string) =>
  await lintSingleRule(RULE, source, { sourcePath, cwd: "scratch" });

const safeImport =
  'import { createSafeTokenHandler } from "@/api/lib/api-handlers";';
const deliveryImport =
  'import { deliverInvoiceLink } from "@/api/handlers/invoice-links/delivery";';

test("requires the canonical delivery call for token handlers", async () => {
  expect(
    await lint(
      `${safeImport}\nexport const route = createSafeTokenHandler(() => Result.err(error));`,
    ),
  ).toEqual([1]);
});

test("rejects direct Result.ok even when delivery is called elsewhere", async () => {
  expect(
    await lint(
      [
        'import { Result as R } from "better-result";',
        safeImport,
        deliveryImport,
        "const response = R.ok(value);",
        "await deliverInvoiceLink(args);",
      ].join("\n"),
    ),
  ).toEqual([4]);
});

test("accepts gated handlers and ignores helpers without the token factory", async () => {
  expect(
    await lint(
      [
        safeImport,
        deliveryImport,
        "export const route = createSafeTokenHandler(async () => await deliverInvoiceLink(args));",
      ].join("\n"),
    ),
  ).toEqual([]);
  expect(
    await lint(
      'import { Result } from "better-result";\nreturn Result.ok(value);',
    ),
  ).toEqual([]);
});

test("requires directly supplied response callbacks to be synchronous", async () => {
  expect(
    await lint(
      [
        deliveryImport,
        "deliverInvoiceLink({",
        "  response: async () => value,",
        "});",
        "deliverInvoiceLink({",
        "  response: async function () { return value; },",
        "});",
        "deliverInvoiceLink({",
        "  async response() { return value; },",
        "});",
        "deliverInvoiceLink({",
        "  *response() { return value; },",
        "});",
        "deliverInvoiceLink({ response: () => value });",
      ].join("\n"),
    ),
  ).toEqual([3, 6, 9, 12]);
});
