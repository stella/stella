import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

describe("no-dom-node-poll-assertion", () => {
  test("reports node matchers inside waitFor", async () => {
    expect(
      await lintSingleRule(
        "no-dom-node-poll-assertion",
        'import { screen, waitFor } from "@testing-library/react";\nawait waitFor(() => expect(screen.queryByText("a")).toBeNull());\nawait waitFor(() => { expect(view.getByRole("switch")).toHaveAttribute("x"); });\nawait waitFor(() => expect(document.querySelector("li")).not.toBeNull());\nawait waitFor(() => expect(getByText("a")).not.toBeTruthy());',
        { sourcePath: "source.test.tsx" },
      ),
    ).toEqual([2, 3, 4, 5]);
  });
  test("accepts values, throwing presence checks and waits outside polls", async () => {
    expect(
      await lintSingleRule(
        "no-dom-node-poll-assertion",
        'import { screen, waitFor } from "@testing-library/react";\nawait waitFor(() => expect(screen.queryByText("a") === null).toBe(true));\nawait waitFor(() => expect(screen.getByText("a")).toBeTruthy());\nawait waitFor(() => expect(screen.getAllByRole("row").length).toBe(2));\nexpect(screen.queryByText("a")).toBeNull();',
        { sourcePath: "source.test.tsx" },
      ),
    ).toEqual([]);
  });
});
