import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-swallowed-item-error";

describe.serial("item errors remain observable", () => {
  test("rejects skipped items, empty catches and constant promise fallbacks", async () => {
    expect(
      await lintSingleRule(
        RULE,
        [
          "for (const item of items) { try { buildDecision(item); } catch { continue; } }",
          "for (const item of items) { try { await assembleDecision(item); } catch (error) {} }",
          "for (const item of items) { await build(item).catch(() => undefined); }",
          "for (const item of items) { await build(item).catch(() => null); }",
          "for (const item of items) { await build(item).catch(() => []); }",
          "function read() { for (const item of items) { try { build(item); } catch { return; } } }",
          "for (const item of items) { await build(item).catch(() => {}); }",
          "items.map(async (item) => { try { await build(item); } catch {} });",
          "items.forEach((item) => { build(item).catch(() => { return null; }); });",
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("permits propagation, typed records and independently scoped parsing", async () => {
    expect(
      await lintSingleRule(
        RULE,
        [
          "for (const item of items) { try { build(item); } catch (error) { throw error; } }",
          "for (const item of items) { try { build(item); } catch (error) { failures.push(new ItemBuildFailed({ cause: error })); continue; } }",
          "for (const item of items) { build(item).catch((error) => { failures.push(new ItemBuildFailed({ cause: error })); }); }",
          "for (const item of items) { const decode = () => { try { return JSON.parse(item); } catch { return null; } }; }",
          "function optional() { try { JSON.parse(raw); } catch { return undefined; } }",
          'for (const item of items) { build(item).catch((error) => ({ type: "item_build_failed", cause: error })); }',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("rejects constant fallback values in every item catch form", async () => {
    const fallbacks = [
      "false",
      "true",
      "0",
      "42",
      "-1",
      "1.5",
      '""',
      '"fallback"',
      "`fallback`",
      "{}",
      "undefined",
      "null",
      "[]",
      "void 0",
      "[false, 42]",
      '{ status: "failed" }',
    ];
    const source = fallbacks.flatMap((fallback) => [
      `for (const item of items) { build(item).catch(() => (${fallback})); }`,
      `items.map((item) => build(item).catch(() => { return ${fallback}; }));`,
      `function run() { for (const item of items) { try { build(item); } catch { return ${fallback}; } } }`,
    ]);
    expect(await lintSingleRule(RULE, source.join("\n"))).toEqual(
      source.map((_, index) => index + 1),
    );
  });

  test("a ledgered hit is accepted, a new hit fails and stale entries fail", async () => {
    const sourcePath =
      ".oxlint-plugins/__fixtures__/no-swallowed-item-error.fixture.legacy.ts";
    const legacy =
      "for (const item of items) { try { String(item); } catch { continue; } }";
    expect(await lintSingleRule(RULE, legacy, { sourcePath })).toEqual([]);
    expect(
      await lintSingleRule(RULE, `${legacy}\n${legacy}`, { sourcePath }),
    ).toEqual([2]);
    expect(
      await lintSingleRule(
        RULE,
        `${legacy}\nfor (const item of items) { try { newBuild(item); } catch { continue; } }`,
        { sourcePath },
      ),
    ).toEqual([2]);
    expect(
      await lintSingleRule(RULE, "export const corrected = true;", {
        sourcePath,
      }),
    ).toEqual([1]);
    expect(
      await lintSingleRule(
        RULE,
        "for (const item of items) { try { replacement(item); } catch { continue; } }",
        { sourcePath },
      ),
    ).toEqual([1, 1]);
  });
});
