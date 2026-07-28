import { describe, expect, test } from "bun:test";

import { parseFirm } from "./parse.js";

describe("Zefix parser", () => {
  test("rejects a nine-digit UID with an invalid checksum", () => {
    expect(
      parseFirm({
        name: "Invalid UID AG",
        uidFormatted: "CHE-191.546.435",
      }),
    ).toBeNull();
  });
});
