import { describe, expect, test } from "bun:test";

import { HISTORY_STATE_OWNERS } from "../no-raw-history-state.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (
  source: string,
  sourcePath = "apps/web/src/components/back-button.tsx",
) => await lintSingleRule("no-raw-history-state", source, { sourcePath });

// One flagged read per line, numbered from 1.
const browserHistoryReads = [
  "const state: unknown = window.history.state;",
  "const entries = history.length;",
  "const global = globalThis.history.state;",
  "const worker = self.history.length;",
  'const computed = window.history["state"];',
  "const { state: destructured } = window.history;",
  "const { length } = history;",
  "const optional = window?.history?.state;",
].join("\n");

const otherReads = [
  "if (router.history.canGoBack()) router.history.back();",
  "const locationState = router.state.location.state;",
  "const undo = (history: string[]) => history.length;",
  "const capture = (window: { history: { state: unknown } }) => window.history.state;",
  "window.history.replaceState(null, '', '/');",
  "const { back } = window.history;",
].join("\n");

const flaggedLines = Array.from(
  { length: browserHistoryReads.split("\n").length },
  (_, index) => index + 1,
);

describe("browser history state", () => {
  test("rejects reading state or length off the global history", async () => {
    expect(await lint(browserHistoryReads)).toEqual(flaggedLines);
  });

  test("accepts the router's history and shadowed bindings", async () => {
    expect(await lint(otherReads)).toEqual([]);
  });

  test("admits raw reads only in the router setup", async () => {
    // This pinned boundary fails when an owner exemption is added.
    expect(HISTORY_STATE_OWNERS).toEqual(["apps/web/src/router.tsx"]);
    const cases = [
      { sourcePath: "apps/web/src/router.tsx", expected: [] },
      { sourcePath: "apps/web/src/lib/router.tsx", expected: [1] },
    ];
    const results = await Promise.all(
      cases.map(async ({ sourcePath }) => ({
        sourcePath,
        result: await lint(
          'window.history.replaceState(window.history.state, "", "/");',
          sourcePath,
        ),
      })),
    );
    expect(results).toEqual(
      cases.map(({ sourcePath, expected }) => ({
        sourcePath,
        result: expected,
      })),
    );
  });
});
