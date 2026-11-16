import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";

import {
  loadParserFingerprints,
  PARSER_FINGERPRINT_DIRECTORY,
  writeParserFingerprint,
} from "./replay-parser-fingerprints";

test("each registered adapter has exactly one valid fingerprint and no orphan files", async () => {
  expect(Object.keys(await loadParserFingerprints()).toSorted()).toEqual(
    Object.values(ADAPTER_KEYS).toSorted(),
  );
  expect((await readdir(PARSER_FINGERPRINT_DIRECTORY)).toSorted()).toEqual(
    Object.values(ADAPTER_KEYS)
      .map((key) => `${key}.json`)
      .toSorted(),
  );
});

test("fingerprints cannot be registered in the retired aggregate file", async () => {
  expect(
    await Bun.file(
      new URL("replay-parser-fingerprints.json", import.meta.url),
    ).exists(),
  ).toBe(false);
});

for (const operation of ["add", "bump", "bump-and-add"]) {
  test(`different parser ${operation}s merge cleanly and retain both values`, async () => {
    const temporary = await mkdtemp(
      path.join(tmpdir(), "parser-fingerprint-merge-"),
    );
    const directory = pathToFileURL(`${temporary}/registry/`);
    await mkdir(directory);
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], {
        cwd: temporary,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "Registry test",
          GIT_AUTHOR_EMAIL: "registry@example.invalid",
          GIT_COMMITTER_NAME: "Registry test",
          GIT_COMMITTER_EMAIL: "registry@example.invalid",
        },
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return result.stdout.toString().trim();
    };
    const entry = (version: number) => ({
      version,
      fingerprint: version === 1 ? "a".repeat(64) : "b".repeat(64),
    });
    try {
      git("init", "--initial-branch=base");
      await writeFile(path.join(temporary, "README"), "registry\n");
      if (operation !== "add") {
        const existingKeys =
          operation === "bump" ? ["parser-a", "parser-b"] : ["parser-a"];
        for (const key of existingKeys) {
          await writeParserFingerprint({
            key,
            fingerprint: entry(1),
            directory,
          });
        }
      }
      git("add", ".");
      git("commit", "-m", "base");
      for (const key of ["parser-a", "parser-b"]) {
        git("switch", "-c", key, "base");
        await mkdir(directory, { recursive: true });
        await writeParserFingerprint({ key, fingerprint: entry(2), directory });
        const file = new URL(`${key}.json`, directory);
        expect(
          git("status", "--porcelain", "--untracked-files=all").trim(),
        ).toMatch(new RegExp(`^(?:M|\\?\\?) registry/${key}\\.json$`, "u"));
        const historicalTime = new Date("2000-01-01T00:00:00.000Z");
        await utimes(file, historicalTime, historicalTime);
        const before = await stat(file);
        await writeParserFingerprint({ key, fingerprint: entry(2), directory });
        expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
        git("add", ".");
        git("commit", "-m", key);
      }
      const tree = git("merge-tree", "--write-tree", "parser-a", "parser-b");
      git("read-tree", "--reset", "-u", tree);
      expect(await loadParserFingerprints(directory)).toEqual({
        "parser-a": entry(2),
        "parser-b": entry(2),
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
}
