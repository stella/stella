import { expect, test } from "bun:test";
import path from "node:path";

import {
  fingerprintEvolutionFailures,
  scanExternalIdentity,
} from "./source-fingerprint-baseline";

const fingerprint = (
  value: string,
  storedInputIdentity: string,
  version: number,
) => ({
  fingerprint: value,
  storedInputIdentity,
  version,
});

test("the source fingerprint baseline and evolution guard match the tree", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "scripts/source-fingerprint-baseline.ts",
      "--check",
      "--base",
      "origin/main",
    ],
    {
      cwd: path.resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(
    result.exitCode,
    `${result.stdout.toString()}${result.stderr.toString()}`,
  ).toBe(0);
}, 120_000);

test("accepts a fingerprint change over changed stored bytes without a version bump", () => {
  expect(
    fingerprintEvolutionFailures(
      { "cz-ns::decision": fingerprint("new", "new-input", 0) },
      { "cz-ns::decision": fingerprint("old", "old-input", 0) },
    ),
  ).toEqual([]);
});

test("rejects an allowlisted adapter hash change over unchanged stored bytes without a version bump", () => {
  expect(
    fingerprintEvolutionFailures(
      { "pl-courts::search": fingerprint("new", "same-input", 0) },
      { "pl-courts::search": fingerprint("old", "same-input", 0) },
    ),
  ).toEqual([
    "pl-courts::search: fixture fingerprint changed without a version bump",
  ]);
});

test("accepts an allowlisted adapter hash change over unchanged stored bytes with a version bump", () => {
  expect(
    fingerprintEvolutionFailures(
      { "pl-courts::search": fingerprint("new", "same-input", 1) },
      { "pl-courts::search": fingerprint("old", "same-input", 0) },
    ),
  ).toEqual([]);
});

test("rejects a fingerprint version decrease", () => {
  expect(
    fingerprintEvolutionFailures(
      { "cz-ns::decision": fingerprint("same", "same-input", 0) },
      { "cz-ns::decision": fingerprint("same", "same-input", 1) },
    ),
  ).toEqual(["cz-ns::decision: fingerprint version decreased"]);
});

test("writer keys preserve method ownership and omit accessor and constructor names", () => {
  const file = "apps/api/src/example.ts";
  const source = `
    const writer = { save() { return { externalSource: "x", externalId: id }; } };
    class Writer {
      save() { return { externalSource: "x", externalId: id }; }
      get value() { return { externalSource: "x", externalId: id }; }
      constructor() { const row = { externalSource: "x", externalId: id }; }
    }
  `;
  expect(
    scanExternalIdentity([{ path: file, source }]).map(({ key }) => key),
  ).toEqual([
    `${file}::external-id-write::Writer`,
    `${file}::external-id-write::Writer/row`,
    `${file}::external-id-write::Writer/save`,
    `${file}::external-id-write::writer/save`,
  ]);
});
