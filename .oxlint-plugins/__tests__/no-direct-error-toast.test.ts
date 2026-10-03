import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const imported = 'import { stellaToast as notices } from "@stll/ui/toast";';
const lint = async (source: string, sourcePath = "apps/web/src/example.ts") =>
  await lintSingleRule("no-direct-error-toast", source, { sourcePath });

describe("shared error toast ownership", () => {
  test("confines dynamic toast methods that can select the error sink", async () => {
    expect(
      await lint(
        `${imported}\nnotices[method]("Failed");\nconst emit = notices[method];\nemit("Failed");`,
      ),
    ).toEqual([2, 4]);
  });
  test("rejects the direct error method and its aliases", async () => {
    expect(
      await lint(
        `${imported}\nnotices.error("Failed");\nconst fail = notices.error;\nfail("Failed");`,
      ),
    ).toEqual([2, 4]);
  });

  test("permits conditional non-error options and rejects conditional error spreads", async () => {
    expect(
      await lint(
        `${imported}\nnotices.add({ type: "success", title: "Saved", ...(hasDescription && { description: "Done" }) });\nnotices.add({ title: "Failed", ...(flag && { type: "error" }) });`,
      ),
    ).toEqual([3]);
  });
  test("detects add, update, descriptor aliases, spreads and method aliases", async () => {
    expect(
      await lint(
        [
          imported,
          'notices.add({ type: "error", title: "Failed" });',
          'const descriptor = { type: "error" as const, title: "Failed" };',
          "const alias = descriptor;",
          'notices.update("id", alias);',
          "const manager = notices;",
          "manager.add({ ...descriptor });",
          "const create = manager.add;",
          'create({ type: "error" });',
          "const { update: revise } = manager;",
          'revise("id", descriptor);',
          'notices["add"]({ type: "error" });',
          'notices.add(flag ? { type: "success" } : descriptor);',
        ].join("\n"),
      ),
    ).toEqual([2, 5, 7, 9, 11, 12, 13]);
  });

  test("rejects unknown type expressions and resolves local type aliases", async () => {
    expect(
      await lint(
        [
          imported,
          'const ERROR = "error" as const;',
          "notices.add({ type: ERROR });",
          "notices.add({ type: result.tone });",
          'notices.add({ type: flag ? "warning" : "info" });',
          'notices.add({ type: flag ? "error" : "success" });',
        ].join("\n"),
      ),
    ).toEqual([3, 4, 6]);
  });

  test("confines opaque descriptor factories and function parameters", async () => {
    expect(
      await lint(
        [
          imported,
          "notices.add(makeErrorToast(error));",
          "const descriptor = makeToast(outcome);",
          'notices.update("id", descriptor);',
          "function update(descriptor: unknown) { notices.add(descriptor); }",
        ].join("\n"),
      ),
    ).toEqual([2, 4, 5]);
  });

  test("rejects promise toasts because rejection creates an error toast", async () => {
    expect(
      await lint(`${imported}\nnotices.promise(operation, labels);`),
    ).toEqual([2]);
  });

  test("resolves namespace imports and preserves lexical shadowing", async () => {
    expect(
      await lint(
        [
          'import * as ui from "@stll/ui/toast";',
          'ui.stellaToast.add({ type: "error" });',
          "function unrelated(ui: { stellaToast: { add: (x: unknown) => void } }) {",
          'ui.stellaToast.add({ type: "error" });',
          "}",
        ].join("\n"),
      ),
    ).toEqual([2]);
  });

  test("keeps success, loading and informational updates unchanged", async () => {
    expect(
      await lint(
        [
          imported,
          'notices.add({ type: "success", title: "Saved" });',
          'notices.add({ type: "loading", title: "Saving" });',
          'notices.update("id", { description: "Working" });',
          'notices.add({ type: "info", title: "Ready" });',
          'notices.close("id");',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test.each(["apps/web/src/lib/errors/user-toast.ts"])(
    "allows the canonical owner %s",
    async (sourcePath) => {
      expect(
        await lint(`${imported}\nnotices.add({ type: "error" });`, sourcePath),
      ).toEqual([]);
    },
  );
});
