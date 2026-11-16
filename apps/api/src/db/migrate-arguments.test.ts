import { describe, expect, test } from "bun:test";

import { parseMigrateArguments } from "./migrate-arguments";
import { ONLINE_SCOPE } from "./online-step-lifecycle";

describe("migrate arguments", () => {
  test("builds every online entry unless asked otherwise", () => {
    expect(parseMigrateArguments([])).toEqual({
      reportPath: null,
      onlineScope: ONLINE_SCOPE.all,
    });
  });

  test("accepts the finalized scope", () => {
    expect(parseMigrateArguments(["--online=finalized"])).toEqual({
      reportPath: null,
      onlineScope: ONLINE_SCOPE.finalized,
    });
  });

  test("keeps the rehearsal report beside the default scope", () => {
    expect(
      parseMigrateArguments([
        "--online=all",
        "--rehearsal-online-repair-report",
        "report.json",
      ]),
    ).toEqual({ reportPath: "report.json", onlineScope: ONLINE_SCOPE.all });
  });

  test.each([
    [["--online=pending"], "Usage: migrate.ts"],
    [["--online="], "Usage: migrate.ts"],
    [["--online=all", "--online=finalized"], "Usage: migrate.ts"],
    [
      ["--online=finalized", "--rehearsal-online-repair-report", "r.json"],
      "requires --online=all",
    ],
    [["--unknown"], "Usage: migrate.ts"],
  ])("refuses %j", (args, message) => {
    expect(() => parseMigrateArguments(args)).toThrow(message);
  });
});
