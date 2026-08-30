import { describe, expect, test } from "bun:test";

import { withCheckerSplit } from "./tsc-native";

describe("tsc-native checker split", () => {
  test("pins one checker so a typecheck cannot depend on the file split", () => {
    expect(withCheckerSplit(["--noEmit"])).toEqual([
      "--singleThreaded",
      "--noEmit",
    ]);
  });

  test("leaves an explicit split alone", () => {
    expect(withCheckerSplit(["-p", "apps/web", "--checkers", "4"])).toEqual([
      "-p",
      "apps/web",
      "--checkers",
      "4",
    ]);
    expect(withCheckerSplit(["--singleThreaded", "--noEmit"])).toEqual([
      "--singleThreaded",
      "--noEmit",
    ]);
  });
});
