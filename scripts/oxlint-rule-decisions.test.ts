// Guard: preset rules this repository turns off on purpose stay off.

import { expect, test } from "bun:test";

import config from "../oxlint.config.ts";

test("keeps oxc/no-map-spread off: object spread is the one record-copy form", () => {
  expect(config.rules?.["oxc/no-map-spread"]).toBe("off");
});
