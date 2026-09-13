import { describe, expect, test } from "bun:test";

import { publicLawInspectorPresence } from "@/routes/law/-components/public-law-inspector.logic";

describe("which inspector a public law route docks", () => {
  // The rail is part of the shell, not something a tab summons: without this
  // a fresh /law page offered no way to open the panel at all.
  test("a reader without a session still gets the dock", () => {
    expect(
      publicLawInspectorPresence({
        caseReaderOwnsDock: false,
        hasSession: false,
      }),
    ).toBe("anonymous");
  });

  test("a reader with a session gets the workspace inspector", () => {
    expect(
      publicLawInspectorPresence({
        caseReaderOwnsDock: false,
        hasSession: true,
      }),
    ).toBe("session");
  });

  // Two docks would sit on top of each other, so the shell yields wherever the
  // case reader mounts its own — for a reader with a session and without one.
  test("the case reader's own dock wins, whoever is reading", () => {
    for (const hasSession of [true, false]) {
      expect(
        publicLawInspectorPresence({ caseReaderOwnsDock: true, hasSession }),
      ).toBe("none");
    }
  });
});
