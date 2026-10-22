import { expect, test } from "bun:test";

import {
  decodePlanFileList,
  decodePostgresTestSelection,
  encodePlanFileList,
  encodePostgresTestSelection,
  type PostgresTestSelection,
} from "./plan-output-codec";

test("plan file lists round trip through the compact output codec", () => {
  const files = ["src/one.test.ts", "src/unicode-é.test.ts"];
  expect(decodePlanFileList(encodePlanFileList(files))).toEqual(files);
});

test("every Postgres selection mode round trips through the compact output codec", () => {
  const selections: PostgresTestSelection[] = [
    { mode: "all" },
    { mode: "none" },
    { mode: "selected", files: ["src/one.postgres.test.ts"] },
  ];
  for (const selection of selections) {
    expect(
      decodePostgresTestSelection(encodePostgresTestSelection(selection)),
    ).toEqual(selection);
  }
});
