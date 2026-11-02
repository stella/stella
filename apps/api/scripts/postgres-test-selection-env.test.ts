import { expect, test } from "bun:test";

import { encodePostgresTestSelection } from "../../../scripts/plan-output-codec";
import { parseGatedTestSelection } from "./gated-test-selection";
import { postgresTestSelectionFromEnv } from "./postgres-test-selection-env";

const discovered = ["src/a.db.test.ts", "src/b.db.test.ts"];

test("an empty or absent encoded selection runs every discovered suite", () => {
  for (const encoded of [undefined, ""]) {
    const selection = postgresTestSelectionFromEnv(encoded);
    expect(selection).toBeUndefined();
    expect(parseGatedTestSelection(selection, discovered)).toEqual({
      mode: "all",
    });
  }
});

test("an encoded selection reaches the gated runner unchanged", () => {
  const selected = { mode: "selected" as const, files: ["src/b.db.test.ts"] };
  expect(
    parseGatedTestSelection(
      postgresTestSelectionFromEnv(encodePostgresTestSelection(selected)),
      discovered,
    ),
  ).toEqual(selected);
});
