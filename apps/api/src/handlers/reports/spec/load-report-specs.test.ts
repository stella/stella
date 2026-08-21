import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ReportSpecObjectStore } from "./load-report-specs";
import {
  bundledReportSpecSources,
  loadReportSpecs,
  MAX_S3_SPEC_FILE_BYTES,
  MAX_S3_SPECS,
  parseS3SpecPrefix,
  readReportSpecSourcesFromS3,
} from "./load-report-specs";

const tempDirs: string[] = [];

const specsDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "report-specs-"));
  tempDirs.push(dir);
  return dir;
};

const writeSpec = (
  root: string,
  key: string,
  spec: unknown,
  prompts: Record<string, string> = {},
) => {
  const dir = path.join(root, key);
  mkdirSync(path.join(dir, "prompts"), { recursive: true });
  writeFileSync(path.join(dir, "spec.json"), JSON.stringify(spec));
  for (const [ref, text] of Object.entries(prompts)) {
    writeFileSync(path.join(dir, "prompts", `${ref}.md`), text);
  }
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadReportSpecs", () => {
  test("the bundled default parses and resolves its prompt refs", async () => {
    const loaded = await loadReportSpecs({
      bundled: bundledReportSpecSources(),
      runtime: { type: "none" },
    });
    expect(Result.isOk(loaded)).toBe(true);
    if (Result.isError(loaded)) {
      return;
    }
    const tableReport = loaded.value.get("table-report");
    expect(tableReport?.spec.name).toBe("Table report");
    expect(tableReport?.prompts.get("exec-summary")).toContain(
      "executive summary",
    );
  });

  test("a REPORT_SPECS_DIR key overrides the bundled one and new keys are added", async () => {
    const root = specsDir();
    writeSpec(
      root,
      "table-report",
      {
        version: 1,
        name: "Overridden",
        sections: [{ kind: "narrative", prompt: { ref: "intro" } }],
      },
      { intro: "Intro prompt." },
    );
    writeSpec(root, "extra", { version: 1, name: "Extra", sections: [] });
    // Stray files and spec-less directories are ignored.
    writeFileSync(path.join(root, "README.md"), "ignored");
    mkdirSync(path.join(root, "empty"));

    const loaded = await loadReportSpecs({
      bundled: bundledReportSpecSources(),
      runtime: { type: "dir", specsDir: root },
    });
    expect(Result.isOk(loaded)).toBe(true);
    if (Result.isError(loaded)) {
      return;
    }
    expect([...loaded.value.keys()].sort()).toEqual(["extra", "table-report"]);
    expect(loaded.value.get("table-report")?.spec.name).toBe("Overridden");
    expect(loaded.value.get("table-report")?.prompts.get("intro")).toBe(
      "Intro prompt.",
    );
  });

  test("an invalid runtime spec is a boot error naming the key", async () => {
    const root = specsDir();
    writeSpec(root, "broken", {
      version: 1,
      name: "Broken",
      sections: [{ kind: "chart" }],
    });
    const loaded = await loadReportSpecs({
      bundled: new Map(),
      runtime: { type: "dir", specsDir: root },
    });
    expect(Result.isError(loaded)).toBe(true);
    if (Result.isOk(loaded)) {
      return;
    }
    expect(loaded.error.message).toContain('Report spec "broken"');
  });

  test("a missing prompt ref and malformed JSON are boot errors", async () => {
    const root = specsDir();
    writeSpec(root, "noprompt", {
      version: 1,
      name: "No prompt",
      sections: [
        {
          kind: "appendix",
          heading: "A",
          children: [{ kind: "narrative", prompt: { ref: "absent" } }],
        },
      ],
    });
    const missing = await loadReportSpecs({
      bundled: new Map(),
      runtime: { type: "dir", specsDir: root },
    });
    expect(Result.isError(missing) && missing.error.message).toContain(
      "prompts/absent.md",
    );

    const root2 = specsDir();
    mkdirSync(path.join(root2, "bad"));
    writeFileSync(path.join(root2, "bad", "spec.json"), "{ not json");
    const malformed = await loadReportSpecs({
      bundled: new Map(),
      runtime: { type: "dir", specsDir: root2 },
    });
    expect(Result.isError(malformed) && malformed.error.message).toContain(
      "not valid JSON",
    );
  });

  test("a missing directory is a boot error", async () => {
    const loaded = await loadReportSpecs({
      bundled: new Map(),
      runtime: { type: "dir", specsDir: path.join(specsDir(), "nope") },
    });
    expect(Result.isError(loaded)).toBe(true);
  });
});

// ── S3 source ────────────────────────────────────────────────────────────────

const BUCKET = "stella-config";
const PREFIX = "report-specs/";
const LOCATION = { bucket: BUCKET, prefix: PREFIX };

/** In-memory store honouring the same ceilings the real helpers enforce: a
 *  listing stops at `maxKeys + 1`, a read refuses a body past `maxBytes`. */
const memoryStore = (
  objects: Record<string, string>,
): ReportSpecObjectStore & { reads: string[] } => {
  const encoded = new Map(
    Object.entries(objects).map(([key, text]) => [
      key,
      new TextEncoder().encode(text),
    ]),
  );
  const reads: string[] = [];
  return {
    reads,
    listKeys: async ({ bucket, prefix, maxKeys }) => {
      expect(bucket).toBe(BUCKET);
      return await Promise.resolve(
        [...encoded.keys()]
          .filter((key) => key.startsWith(prefix))
          .sort()
          .slice(0, maxKeys + 1),
      );
    },
    readObject: async ({ bucket, key, maxBytes }) => {
      expect(bucket).toBe(BUCKET);
      reads.push(key);
      const bytes = encoded.get(key);
      if (bytes === undefined) {
        throw new Error(`NoSuchKey: ${key}`);
      }
      if (bytes.byteLength > maxBytes) {
        throw new Error(
          `${key} declares ${bytes.byteLength} bytes, past the ${maxBytes}-byte ceiling`,
        );
      }
      return await Promise.resolve(bytes);
    },
  };
};

const specJson = (name: string, sections: unknown[]): string =>
  JSON.stringify({ version: 1, name, sections });

describe("parseS3SpecPrefix", () => {
  test("splits bucket and prefix; rejects anything else", () => {
    expect(parseS3SpecPrefix("s3://b/report-specs/v1/")).toEqual(
      Result.ok({ bucket: "b", prefix: "report-specs/v1/" }),
    );
    expect(parseS3SpecPrefix("s3://b/")).toEqual(
      Result.ok({ bucket: "b", prefix: "" }),
    );
    for (const bad of ["s3://b/no-slash", "s3://b", "https://b/p/", ""]) {
      expect(Result.isError(parseS3SpecPrefix(bad))).toBe(true);
    }
  });
});

describe("readReportSpecSourcesFromS3", () => {
  test("happy path: specs with prompts load through the same validation as the directory form", async () => {
    const store = memoryStore({
      [`${PREFIX}dd-lite/spec.json`]: specJson("DD lite", [
        { kind: "narrative", prompt: { ref: "intro" } },
      ]),
      [`${PREFIX}dd-lite/prompts/intro.md`]: "Intro prompt.",
      [`${PREFIX}dd-lite/prompts/unused.md`]: "Not referenced.",
      [`${PREFIX}plain/spec.json`]: specJson("Plain", []),
      // Ignored like stray files in the directory form.
      [`${PREFIX}README.md`]: "ignored",
      [`${PREFIX}plain/notes.txt`]: "ignored",
      [`${PREFIX}deep/nested/spec.json`]: "ignored",
    });
    const loaded = await loadReportSpecs({
      bundled: bundledReportSpecSources(),
      runtime: { type: "s3", store, location: LOCATION },
    });
    expect(Result.isOk(loaded)).toBe(true);
    if (Result.isError(loaded)) {
      return;
    }
    expect([...loaded.value.keys()].sort()).toEqual([
      "dd-lite",
      "plain",
      "table-report",
    ]);
    expect(loaded.value.get("dd-lite")?.prompts.get("intro")).toBe(
      "Intro prompt.",
    );
    expect(store.reads.sort()).toEqual([
      `${PREFIX}dd-lite/prompts/intro.md`,
      `${PREFIX}dd-lite/prompts/unused.md`,
      `${PREFIX}dd-lite/spec.json`,
      `${PREFIX}plain/spec.json`,
    ]);
  });

  test("a missing prompt ref is a boot error naming the file", async () => {
    const store = memoryStore({
      [`${PREFIX}dd-lite/spec.json`]: specJson("DD lite", [
        { kind: "narrative", prompt: { ref: "absent" } },
      ]),
    });
    const loaded = await loadReportSpecs({
      bundled: new Map(),
      runtime: { type: "s3", store, location: LOCATION },
    });
    expect(Result.isError(loaded) && loaded.error.message).toContain(
      "prompts/absent.md",
    );
  });

  test("a file past the per-file ceiling is a typed boot error", async () => {
    const oversized = specJson("Big", []).padEnd(
      MAX_S3_SPEC_FILE_BYTES + 1,
      " ",
    );
    expect(new TextEncoder().encode(oversized).byteLength).toBeGreaterThan(
      MAX_S3_SPEC_FILE_BYTES,
    );
    const store = memoryStore({ [`${PREFIX}big/spec.json`]: oversized });
    const read = await readReportSpecSourcesFromS3({
      store,
      location: LOCATION,
    });
    expect(Result.isError(read)).toBe(true);
    if (Result.isOk(read)) {
      return;
    }
    expect(read.error._tag).toBe("ConfigurationError");
    expect(read.error.message).toContain('Report spec "big"');
  });

  test("more specs than the ceiling is a typed boot error before any read", async () => {
    const objects: Record<string, string> = {};
    for (let index = 0; index <= MAX_S3_SPECS; index += 1) {
      objects[`${PREFIX}spec-${String(index).padStart(3, "0")}/spec.json`] =
        specJson(`Spec ${index}`, []);
    }
    const store = memoryStore(objects);
    const read = await readReportSpecSourcesFromS3({
      store,
      location: LOCATION,
    });
    expect(Result.isError(read) && read.error.message).toContain(
      `more than the ${MAX_S3_SPECS} allowed`,
    );
    expect(store.reads).toEqual([]);
  });
});
