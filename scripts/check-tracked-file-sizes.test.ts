import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BASELINE_PATHS } from "./baseline-paths";
import {
  evaluateSizes,
  parseSizeBaseline,
  type SizeBaselineEntry,
  TRACKED_FILE_SIZE_LIMIT_BYTES,
  trackedBlobs,
} from "./check-tracked-file-sizes";
import { ledgerGitEnv } from "./ledger-membership";

const LIMIT = TRACKED_FILE_SIZE_LIMIT_BYTES;
const SCRIPT = path.join(import.meta.dir, "check-tracked-file-sizes.ts");

const git = (root: string, args: readonly string[]) => {
  const result = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd: root, env: ledgerGitEnv(), stdout: "pipe", stderr: "pipe" },
  );
  expect(result.stderr.toString()).not.toContain("fatal");
  expect(result.exitCode).toBe(0);
};

const write = (root: string, file: string, content: string | Buffer) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), content);
};

/** A real repository whose HEAD commits each file at the given byte size. */
const withRepo = (
  files: Readonly<Record<string, number>>,
  run: (root: string) => void,
) => {
  const root = mkdtempSync(path.join(tmpdir(), "tracked-file-sizes-"));
  try {
    git(root, ["init", "-q", "-b", "main"]);
    for (const [file, bytes] of Object.entries(files)) {
      write(root, file, Buffer.alloc(bytes, "a"));
    }
    git(root, ["add", "--all"]);
    git(root, ["commit", "-q", "--allow-empty", "-m", "fixture"]);
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const entry = (file: string, maxBytes: number): SizeBaselineEntry => ({
  path: file,
  maxBytes,
  reason: "Fixture entry.",
});

describe("tracked file size limit", () => {
  test("a file exactly at the limit passes", () => {
    withRepo({ "dist/at-limit.bin": LIMIT }, (root) => {
      const blobs = trackedBlobs(root);
      expect(blobs).toEqual([{ path: "dist/at-limit.bin", bytes: LIMIT }]);
      expect(evaluateSizes(blobs, [])).toEqual({ errors: [], baselined: 0 });
    });
  });

  test("a file one byte over the limit fails with how to proceed", () => {
    const file = "dist/app bundle.html";
    withRepo({ [file]: LIMIT + 1 }, (root) => {
      const blobs = trackedBlobs(root);
      expect(blobs).toEqual([{ path: file, bytes: LIMIT + 1 }]);
      const { errors } = evaluateSizes(blobs, []);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(`${file}: ${LIMIT + 1} bytes`);
      expect(errors[0]).toContain(".gitignore");
      expect(errors[0]).toContain(BASELINE_PATHS.trackedFileSizes);
    });
  });

  test("untracked and ignored files never count", () => {
    withRepo({ ".gitignore": 0 }, (root) => {
      write(root, ".gitignore", "dist/\n");
      git(root, ["commit", "-q", "--all", "-m", "ignore dist"]);
      write(root, "dist/bundle.js", Buffer.alloc(LIMIT * 2, "a"));
      write(root, "scratch.bin", Buffer.alloc(LIMIT * 2, "a"));
      const blobs = trackedBlobs(root);
      expect(blobs.map((blob) => blob.path)).toEqual([".gitignore"]);
      expect(evaluateSizes(blobs, []).errors).toEqual([]);
    });
  });
});

describe("tracked file size baseline", () => {
  test("a baselined file within its ceiling passes", () => {
    withRepo({ "fixture.bin": LIMIT + 10 }, (root) => {
      expect(
        evaluateSizes(trackedBlobs(root), [entry("fixture.bin", LIMIT + 10)]),
      ).toEqual({ errors: [], baselined: 1 });
    });
  });

  test("a baselined file that grew past its ceiling fails", () => {
    withRepo({ "fixture.bin": LIMIT + 11 }, (root) => {
      const { errors } = evaluateSizes(trackedBlobs(root), [
        entry("fixture.bin", LIMIT + 10),
      ]);
      expect(errors).toEqual([
        expect.stringContaining(
          `fixture.bin: ${LIMIT + 11} bytes (1.00 MiB) exceeds its baselined ceiling of ${LIMIT + 10} bytes`,
        ),
      ]);
    });
  });

  test("an entry whose file is no longer tracked fails as stale", () => {
    withRepo({ "kept.txt": 1 }, (root) => {
      expect(
        evaluateSizes(trackedBlobs(root), [entry("gone.bin", LIMIT + 10)])
          .errors,
      ).toEqual([
        `${BASELINE_PATHS.trackedFileSizes}: stale entry gone.bin; the file is not tracked, so delete the entry`,
      ]);
    });
  });

  test("an entry whose file is back within the limit fails as stale", () => {
    withRepo({ "fixture.bin": LIMIT }, (root) => {
      const { errors } = evaluateSizes(trackedBlobs(root), [
        entry("fixture.bin", LIMIT + 10),
      ]);
      expect(errors).toEqual([
        expect.stringContaining("stale entry fixture.bin"),
      ]);
      expect(errors[0]).toContain("within the limit");
    });
  });

  const generatorEntry = (maxBytes: number): SizeBaselineEntry => ({
    generator: "hashed-cache",
    maxBytes,
    reason: "Fixture entry.",
  });
  const outputsOf = (id: string) =>
    id === "hashed-cache" ? [".cache/**"] : undefined;

  test("a generator entry covers its outputs under any content-hashed name", () => {
    for (const name of ["0a1b", "9f8e"]) {
      withRepo(
        { [`.cache/${name}.json`]: LIMIT + 10, "small.json": 1 },
        (root) => {
          expect(
            evaluateSizes(
              trackedBlobs(root),
              [generatorEntry(LIMIT + 10)],
              outputsOf,
            ),
          ).toEqual({ errors: [], baselined: 1 });
        },
      );
    }
  });

  test("a generator output past the ceiling, or another oversized file, fails", () => {
    withRepo(
      { ".cache/0a1b.json": LIMIT + 11, "other.bin": LIMIT + 1 },
      (root) => {
        const { errors } = evaluateSizes(
          trackedBlobs(root),
          [generatorEntry(LIMIT + 10)],
          outputsOf,
        );
        expect(errors).toEqual([
          expect.stringContaining(".cache/0a1b.json: "),
          expect.stringContaining("other.bin: "),
        ]);
        expect(errors[0]).toContain("exceeds its baselined ceiling");
        expect(errors[1]).toContain("exceeds the");
      },
    );
  });

  test("a generator entry with no oversized output or an unknown id fails", () => {
    withRepo({ ".cache/0a1b.json": LIMIT }, (root) => {
      expect(
        evaluateSizes(
          trackedBlobs(root),
          [
            generatorEntry(LIMIT + 10),
            { ...generatorEntry(LIMIT + 10), generator: "gone" },
          ],
          outputsOf,
        ).errors,
      ).toEqual([
        `${BASELINE_PATHS.trackedFileSizes}: entry names unknown generator gone; use an id from scripts/generated-files.ts`,
        `${BASELINE_PATHS.trackedFileSizes}: stale entry for generator hashed-cache; none of its outputs exceeds the limit, so delete the entry`,
      ]);
    });
  });

  test("the committed baseline names only declared generators", () => {
    const baseline = parseSizeBaseline(
      readFileSync(
        path.join(import.meta.dir, "..", BASELINE_PATHS.trackedFileSizes),
        "utf-8",
      ),
      BASELINE_PATHS.trackedFileSizes,
    );
    expect(
      evaluateSizes([], baseline).errors.filter((error) =>
        error.includes("unknown generator"),
      ),
    ).toEqual([]);
  });

  test("blank reasons, duplicate paths and ceilings within the limit are rejected", () => {
    const parse = (entries: unknown) =>
      parseSizeBaseline(JSON.stringify(entries), "fixture");
    expect(() => parse([{ ...entry("a", LIMIT + 1), reason: " " }])).toThrow(
      "reason is required",
    );
    expect(() => parse([entry("a", LIMIT + 1), entry("a", LIMIT + 2)])).toThrow(
      "duplicate entry a",
    );
    expect(() => parse([entry("a", LIMIT)])).toThrow(
      "maxBytes must exceed the limit",
    );
    expect(() =>
      parse([
        { generator: "g", maxBytes: LIMIT + 1, reason: "Fixture." },
        { generator: "g", maxBytes: LIMIT + 2, reason: "Fixture." },
      ]),
    ).toThrow("duplicate entry generator g");
  });
});

describe("check-tracked-file-sizes CLI", () => {
  const run = (root: string) => {
    const result = Bun.spawnSync([process.execPath, SCRIPT], {
      cwd: root,
      env: ledgerGitEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      status: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  };

  test("reads the committed baseline and fails on an unbaselined file", () => {
    withRepo({ "big.bin": LIMIT + 1, "baselined.bin": LIMIT + 5 }, (root) => {
      write(
        root,
        BASELINE_PATHS.trackedFileSizes,
        JSON.stringify([entry("baselined.bin", LIMIT + 5)]),
      );
      const failed = run(root);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain(`big.bin: ${LIMIT + 1} bytes`);
      expect(failed.stderr).not.toContain("baselined.bin");

      git(root, ["rm", "-q", "big.bin"]);
      git(root, ["commit", "-q", "-m", "drop big.bin"]);
      const passed = run(root);
      expect(passed.stderr).toBe("");
      expect(passed.status).toBe(0);
      expect(passed.stdout).toContain("1 baselined file");
    });
  });
});
