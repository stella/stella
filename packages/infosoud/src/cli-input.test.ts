import { describe, expect, test } from "bun:test";

import { resolveCliLookupInput } from "./cli-input.js";

describe("resolveCliLookupInput", () => {
  test("parses only the spisova znacka when an explicit court arg is passed", () => {
    expect(
      resolveCliLookupInput({
        courtArg: "OSSCEDC",
        spisInput: "4 T 21/2025 melnik",
      }),
    ).toEqual({
      courtReference: "OSSCEDC",
      parsedSpisZn: {
        bcVec: 21,
        cisloSenatu: 4,
        courtCode: undefined,
        druhVeci: "T",
        rocnik: 2025,
      },
    });
  });
});
