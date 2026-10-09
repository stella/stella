import { expect, test } from "bun:test";

import { readImportUsedAt } from "./import-used-at";

const NOW = new Date("2026-01-02T03:04:05.000Z");

test("import times exclude values outside PostgreSQL storage before clamping", () => {
  for (const value of [
    "-005000-01-01T00:00:00Z",
    "-004713-11-23T23:59:59.999Z",
    "+294277-01-01T00:00:00Z",
    "invalid",
  ]) {
    expect(readImportUsedAt(value, NOW)).toBeNull();
  }
  expect(readImportUsedAt("-004713-11-24T00:00:00Z", NOW)?.toISOString()).toBe(
    "-004713-11-24T00:00:00.000Z",
  );
  expect(readImportUsedAt("2020-01-01T00:00:00Z", NOW)?.toISOString()).toBe(
    "2020-01-01T00:00:00.000Z",
  );
  expect(readImportUsedAt("2027-01-01T00:00:00Z", NOW)).toEqual(NOW);
});
