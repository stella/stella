import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { PropertyTestConfigError } from "./index";
import { REPO_ROOT, parsePinnedSeeds, readPinnedSeeds } from "./pinned-seeds";

const literal = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

test("every pinned seed names an existing test using its explicit property id", () => {
  for (const [key, entries] of Object.entries(readPinnedSeeds())) {
    const separator = key.lastIndexOf("::");
    expect(separator).toBeGreaterThan(0);
    const file = key.slice(0, separator);
    const id = key.slice(separator + 2);
    expect(id.length).toBeGreaterThan(0);
    expect(file).toMatch(/^(apps|packages)\/.+\.test\.tsx?$/u);
    expect(file.split("/")).not.toContain("..");
    const source = readFileSync(path.join(REPO_ROOT, file), "utf-8");
    const quotedId = `["'\x60]${literal(id)}["'\x60]`;
    expect(source).toMatch(
      new RegExp(`\\b(?:test|it)\\(\\s*${quotedId}\\s*,`, "u"),
    );
    expect(source).toMatch(
      new RegExp(`\\bassertProperty\\(\\s*${quotedId}\\s*,`, "u"),
    );
    expect(entries.length).toBeGreaterThan(0);
  }
});

test("rejects malformed paths and missing pin metadata while ignoring comment keys", () => {
  const entry = {
    seed: 123,
    path: "0:1:2",
    note: "Regression coverage",
    date: "2026-09-30",
  };
  expect(
    parsePinnedSeeds({ $comment: "ignored", "file::id": [entry] }),
  ).toEqual({ "file::id": [entry] });
  for (const invalid of [
    { ...entry, path: "" },
    { ...entry, path: "0:x" },
    { ...entry, note: "" },
    { ...entry, date: undefined },
    { ...entry, seed: 1.5 },
  ]) {
    expect(() => parsePinnedSeeds({ "file::id": [invalid] })).toThrow(
      PropertyTestConfigError,
    );
  }
});
