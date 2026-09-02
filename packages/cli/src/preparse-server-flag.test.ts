import { describe, expect, test } from "bun:test";

import { preparseServerFlag } from "./preparse-server-flag.js";

describe("preparseServerFlag", () => {
  test("reads both spellings, anywhere in argv", () => {
    expect(
      preparseServerFlag(["matter", "list", "--server", "https://a.test"]),
    ).toBe("https://a.test");
    expect(preparseServerFlag(["--server=https://a.test", "matter"])).toBe(
      "https://a.test",
    );
    expect(
      preparseServerFlag(["auth", "login", "--server", "https://a.test"]),
    ).toBe("https://a.test");
  });

  test("absent, valueless, or empty yields undefined", () => {
    expect(preparseServerFlag([])).toBeUndefined();
    expect(preparseServerFlag(["matter", "list"])).toBeUndefined();
    // Left for stricli to report as the usage error it is.
    expect(preparseServerFlag(["matter", "list", "--server"])).toBeUndefined();
    expect(
      preparseServerFlag(["matter", "list", "--server", "--json"]),
    ).toBeUndefined();
    expect(preparseServerFlag(["matter", "list", "--server="])).toBeUndefined();
  });

  test("a `--server` after a literal -- is a positional, not a flag", () => {
    expect(
      preparseServerFlag(["capability", "invoke", "--", "--server", "x"]),
    ).toBeUndefined();
  });

  test("does not match a longer flag that starts the same way", () => {
    expect(
      preparseServerFlag(["matter", "list", "--server-name", "x"]),
    ).toBeUndefined();
  });
});
