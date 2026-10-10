import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  collectGithubTargets,
  validatePinnedSource,
} from "../scripts/check-pinned-content";
import {
  buildPinnedSnapshot,
  PINNED_SNAPSHOT_PATH,
  PinnedContentError,
  projectFrontmatter,
  readPinnedSnapshot,
  recordingPinnedSource,
  serializePinnedSnapshot,
} from "../scripts/pinned-content-facts";
import type { PinnedSource } from "../scripts/pinned-content-facts";

const target = {
  directory: "skills/example",
  license: "MIT",
  repo: "example/skills",
  rev: "a".repeat(40),
  slug: "example",
} as const;

const fixtureEntry = () => ({
  target,
  skill: {
    sha256: "b".repeat(64),
    byteLength: 128,
    utf16Length: 126,
    bodyUtf16Length: 12,
    frontmatter: projectFrontmatter({
      name: "example",
      description: "Synthetic description",
      license: "MIT",
      version: null,
    }),
  },
  directories: [{ path: target.directory, itemCount: 0, items: [] }],
  resources: [],
});

const withSnapshotFile = async (run: (file: string) => Promise<void>) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pinned-facts-test-"));
  try {
    await run(path.join(directory, "facts.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const expectSnapshotFailure = async (file: string, message: string) => {
  const failure: unknown = await readPinnedSnapshot([target], file).then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(PinnedContentError);
  expect(
    failure instanceof PinnedContentError ? failure.message : null,
  ).toContain(message);
};

describe("committed pinned facts", () => {
  test("roundtrip canonically and validate the current catalogue", async () => {
    const source = await readPinnedSnapshot(collectGithubTargets());
    expect(await validatePinnedSource(source)).toEqual([]);
    const recording = recordingPinnedSource(source);
    expect(await validatePinnedSource(recording.source)).toEqual([]);
    const rebuilt = await buildPinnedSnapshot(recording.entries());
    expect(serializePinnedSnapshot(rebuilt)).toBe(
      await Bun.file(PINNED_SNAPSHOT_PATH).text(),
    );
  });

  test("the real offline checker succeeds with zero fetch attempts", async () => {
    await withSnapshotFile(async (file) => {
      const monitor = path.join(path.dirname(file), "monitor.ts");
      await Bun.write(
        monitor,
        `let calls = 0;
globalThis.fetch = () => { calls += 1; throw new Error("unexpected fetch"); };
process.on("exit", () => console.log("PINNED_FETCH_ATTEMPTS=" + calls));
`,
      );
      const child = Bun.spawn(
        [
          process.execPath,
          "--preload",
          monitor,
          path.resolve(import.meta.dir, "../scripts/check-pinned-content.ts"),
          "--check",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(stdout).toContain("Pinned content OK");
      expect(stdout).toContain("PINNED_FETCH_ATTEMPTS=0");
    });
  });

  test("the real checker succeeds with all transports blocked", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        path.resolve(
          import.meta.dir,
          "../../../scripts/offline-network-preload.ts",
        ),
        path.resolve(import.meta.dir, "../scripts/check-pinned-content.ts"),
        "--check",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(stdout).toContain("Pinned content OK");
  });
});

describe("pinned facts trust boundary", () => {
  test("rejects an edited fact without its matching digest", async () => {
    await withSnapshotFile(async (file) => {
      const entry = fixtureEntry();
      const snapshot = await buildPinnedSnapshot([entry]);
      const recorded = snapshot.entries.at(0);
      expect(recorded).toBeDefined();
      if (!recorded) {
        throw new PinnedContentError({ message: "Fixture is missing" });
      }
      recorded.skill.byteLength += 1;
      await Bun.write(file, serializePinnedSnapshot(snapshot));
      await expectSnapshotFailure(
        file,
        "digest or canonical content mismatches",
      );
    });
  });

  test("rejects a noncanonical serialization even with a matching digest", async () => {
    await withSnapshotFile(async (file) => {
      await Bun.write(
        file,
        JSON.stringify(await buildPinnedSnapshot([fixtureEntry()])),
      );
      await expectSnapshotFailure(
        file,
        "digest or canonical content mismatches",
      );
    });
  });

  test("rejects missing, extra, and duplicate target coverage", async () => {
    await withSnapshotFile(async (file) => {
      const entry = fixtureEntry();
      for (const entries of [
        [],
        [entry, { ...fixtureEntry(), target: { ...target, slug: "extra" } }],
        [entry, fixtureEntry()],
      ]) {
        await Bun.write(
          file,
          serializePinnedSnapshot(await buildPinnedSnapshot(entries)),
        );
        await expectSnapshotFailure(
          file,
          "enumerate every github skill exactly once",
        );
      }
    });
  });

  test("binds every target identity field to the catalogue", async () => {
    await withSnapshotFile(async (file) => {
      for (const changedTarget of [
        { ...target, slug: "different" },
        { ...target, repo: "different/skills" },
        { ...target, rev: "c".repeat(40) },
        { ...target, directory: "different" },
        { ...target, license: "Apache-2.0" as const },
      ]) {
        const entry = { ...fixtureEntry(), target: changedTarget };
        await Bun.write(
          file,
          serializePinnedSnapshot(await buildPinnedSnapshot([entry])),
        );
        await expectSnapshotFailure(file, "identity mismatches");
      }
    });
  });

  test("rejects a stale parser fingerprint", async () => {
    await withSnapshotFile(async (file) => {
      const snapshot = await buildPinnedSnapshot([fixtureEntry()]);
      expect(snapshot.parserFingerprint).not.toBe("0".repeat(64));
      await Bun.write(
        file,
        serializePinnedSnapshot({
          ...snapshot,
          parserFingerprint: "0".repeat(64),
        }),
      );
      await expectSnapshotFailure(file, "parser fingerprint is stale");
    });
  });

  test("rejects upstream text at every file and frontmatter boundary", async () => {
    await withSnapshotFile(async (file) => {
      const entry = fixtureEntry();
      const snapshot = await buildPinnedSnapshot([entry]);
      for (const invalidEntry of [
        { ...entry, content: "upstream text" },
        { ...entry, skill: { ...entry.skill, content: "upstream text" } },
        { ...entry, skill: { ...entry.skill, body: "upstream body" } },
        {
          ...entry,
          skill: {
            ...entry.skill,
            frontmatter: {
              ...entry.skill.frontmatter,
              description: "upstream prose",
            },
          },
        },
        {
          ...entry,
          resources: [
            {
              path: "references/example.md",
              sha256: "d".repeat(64),
              byteLength: 4,
              utf16Length: 4,
              content: "text",
            },
          ],
        },
      ]) {
        await Bun.write(
          file,
          serializePinnedSnapshot({ ...snapshot, entries: [invalidEntry] }),
        );
        await expectSnapshotFailure(file, "schema is invalid");
      }
    });
  });
});

describe("refresh facts reduction", () => {
  test("records only file measurements, reduced listings, and frontmatter facts", async () => {
    const entry = fixtureEntry();
    const description = "Private synthetic prose 😀";
    const frontmatter = projectFrontmatter({
      name: target.slug,
      description,
      version: "v😀",
      license: " MIT ",
      compatibility: "😀",
      metadata: { "😀": "Synthetic metadata value" },
    });
    const resource = {
      sha256: "d".repeat(64),
      byteLength: new TextEncoder().encode("😀").byteLength,
      utf16Length: "😀".length,
    };
    const resourcePath = `${target.directory}/references/example.md`;
    const listing = {
      itemCount: 1,
      items: [{ path: resourcePath, type: "file", size: resource.byteLength }],
    };
    const upstream = {
      skill: async () => ({ ...entry.skill, frontmatter }),
      directory: async () => listing,
      resource: async () => resource,
    } satisfies PinnedSource;
    const recording = recordingPinnedSource(upstream);
    await recording.source.skill(target);
    await recording.source.directory({ target, directory: target.directory });
    await recording.source.resource({ target, path: resourcePath });
    const snapshot = await buildPinnedSnapshot(recording.entries());
    const serialized = serializePinnedSnapshot(snapshot);
    expect(serialized).not.toContain(description);
    expect(serialized).not.toContain("Synthetic metadata value");
    expect(serialized).not.toContain('"content"');
    expect(serialized).not.toContain('"body"');
    expect(frontmatter).toEqual({
      name: target.slug,
      license: "MIT",
      descriptionUtf16Length: description.length,
      versionUtf16Length: 3,
      licenseUtf16Length: 5,
      compatibilityUtf16Length: 2,
      metadata: [{ keyUtf16Length: 2, valueUtf16Length: 24 }],
    });
    expect(resource).toMatchObject({ byteLength: 4, utf16Length: 2 });
    await withSnapshotFile(async (file) => {
      await Bun.write(file, serialized);
      const replay = await readPinnedSnapshot([target], file);
      expect(
        await replay.directory({ target, directory: target.directory }),
      ).toMatchObject(listing);
      expect(
        await replay.resource({ target, path: resourcePath }),
      ).toMatchObject(resource);
      expect(await replay.skill(target)).toMatchObject({ frontmatter });
    });
  });
});
