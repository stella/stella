import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { writeRegeneratedFile } from "./regenerate.ts";

const FLAG = "STELLA_TEST_REGENERATE";
describe("checked-in artifact regeneration", () => {
  test("throws without the named flag", () => {
    expect(() =>
      writeRegeneratedFile({
        flag: FLAG,
        value: "write",
        file: "/unused",
        contents: "unused",
        environment: {},
      }),
    ).toThrow(`${FLAG}=write`);
  });

  test("throws when the named flag has a different value", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "stella-regenerate-"));
    try {
      expect(() =>
        writeRegeneratedFile({
          flag: FLAG,
          value: "write",
          file: path.join(directory, "artifact.json"),
          contents: "must not be written",
          environment: { [FLAG]: "1" },
        }),
      ).toThrow(`${FLAG}=write`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("writes when the named flag has the exact value", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "stella-regenerate-"));
    const file = path.join(directory, "artifact.json");
    try {
      writeRegeneratedFile({
        flag: FLAG,
        value: "write",
        file,
        contents: "regenerated\n",
        environment: { [FLAG]: "write" },
      });
      expect(readFileSync(file, "utf-8")).toBe("regenerated\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
