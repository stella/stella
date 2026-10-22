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

test("the full-suite selection encodes to the same text on every platform", () => {
  // The workflow's fallback literal is this exact text; raw deflate carries no
  // header, so no operating-system byte can make one host's encoding differ.
  expect(encodePostgresTestSelection({ mode: "all" })).toBe(
    "Q1bKzU9JVbJSSszJUaoFAA==",
  );
});
