import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-shared-checkout-mutation";
const lint = async (source: string) =>
  lintSingleRule(RULE, source, { sourcePath: "source.test.ts" });

describe(RULE, () => {
  test("rejects removal and writes derived from the checkout", async () => {
    expect(
      await lint(
        'import { rm, writeFileSync } from "node:fs";\nimport path from "node:path";\nconst root = new URL("..", import.meta.url);\nawait rm(new URL("fixture.json", root));\nconst checkout = path.join(import.meta.dir, "../../..");\nwriteFileSync(path.join(checkout, "baseline.json"), "changed");',
      ),
    ).toEqual([4, 6]);
  });

  test("rejects mutations through a default node:fs import", async () => {
    expect(
      await lint(
        'import fs from "node:fs";\nimport path from "node:path";\nfs.writeFileSync(path.join(import.meta.dir, "baseline.json"), "changed");\nfs.readFileSync(path.join(import.meta.dir, "baseline.json"), "utf8");',
      ),
    ).toEqual([3]);
  });

  test("rejects a checkout path joined after a leading root or empty segment", async () => {
    expect(
      await lint(
        'import { writeFileSync } from "node:fs";\nimport path from "node:path";\nwriteFileSync(path.join("/", import.meta.dir, "baseline.json"), "changed");\nwriteFileSync(path.join("", import.meta.dir, "baseline.json"), "changed");\nwriteFileSync(path.join("/tmp", import.meta.dir, "out.json"), "changed");',
      ),
    ).toEqual([3, 4]);
  });

  test("rejects a write stream opened on a checkout path", async () => {
    expect(
      await lint(
        'import { createWriteStream } from "node:fs";\nimport path from "node:path";\ncreateWriteStream(path.join(import.meta.dir, "baseline.json"));',
      ),
    ).toEqual([3]);
  });

  // path.resolve keeps the last absolute segment: a checkout part beside a
  // temporary one still targets the checkout.
  test("rejects a checkout path resolved beside a temporary one", async () => {
    expect(
      await lint(
        'import { writeFile } from "node:fs/promises";\nimport { tmpdir } from "node:os";\nimport path from "node:path";\nawait writeFile(path.resolve(tmpdir(), import.meta.dir, "baseline.json"), "changed");',
      ),
    ).toEqual([4]);
  });

  // A unique directory is safe inside the checkout until `..` leaves it.
  test("allows a temporary directory inside the checkout", async () => {
    expect(
      await lint(
        `import { mkdtempSync, rmSync, writeFileSync } from "node:fs";\nimport path from "node:path";\nconst directory = mkdtempSync(path.join(import.meta.dir, "../.cache", "rule-"));\nconst file = path.join(directory, "producer.ts");\nwriteFileSync(file, "changed");\nwriteFileSync(\`\${directory}/consumer.ts\`, "changed");\nrmSync(directory, { force: true, recursive: true });`,
      ),
    ).toEqual([]);
  });

  test("rejects traversal out of a temporary directory inside the checkout", async () => {
    expect(
      await lint(
        `import { mkdtemp, writeFile } from "node:fs/promises";\nimport path from "node:path";\nconst scratch = await mkdtemp(path.join(import.meta.dir, "scratch-"));\nawait writeFile(path.join(scratch, "..", "baseline.json"), "changed");\nawait writeFile(path.resolve(scratch, "../baseline.json"), "changed");\nconst nested = path.join(scratch, "nested");\nawait writeFile(path.join(nested, "../..", "baseline.json"), "changed");\nawait writeFile(\`\${scratch}/../baseline.json\`, "changed");\nawait writeFile(scratch + "/../baseline.json", "changed");\nawait writeFile(path.join(scratch, process.argv[2] ?? ""), "changed");`,
      ),
    ).toEqual([4, 5, 7, 8, 9, 10]);
  });

  test("rejects removing the parent of a temporary directory inside the checkout", async () => {
    expect(
      await lint(
        'import { mkdtemp, rm } from "node:fs/promises";\nimport path from "node:path";\nconst scratch = await mkdtemp(path.join(import.meta.dir, "scratch-"));\nawait rm(path.dirname(scratch), { recursive: true, force: true });',
      ),
    ).toEqual([4]);
  });

  // URL resolution can leave a directory in ways a path cannot (a base
  // without a trailing slash, encoded dots), so a URL against a temporary
  // directory inside the checkout is judged by where it was created.
  test("rejects URLs resolved against a temporary directory inside the checkout", async () => {
    expect(
      await lint(
        `import { mkdtempSync, writeFileSync } from "node:fs";\nimport path from "node:path";\nimport { pathToFileURL } from "node:url";\nconst scratch = mkdtempSync(path.join(import.meta.dir, "scratch-"));\nwriteFileSync(new URL("../baseline.json", pathToFileURL(scratch + "/")), "changed");\nwriteFileSync(new URL("../baseline.json", \`file://\${scratch}/\`), "changed");\nwriteFileSync(new URL("baseline.json", pathToFileURL(scratch)), "changed");\nwriteFileSync(new URL("%2e%2e/baseline.json", pathToFileURL(scratch + "/")), "changed");\nwriteFileSync(new URL("fixture.json", pathToFileURL(scratch + "/")), "changed");`,
      ),
    ).toEqual([5, 6, 7, 8, 9]);
  });

  test("rejects writes and removals derived from CommonJS module locations", async () => {
    expect(
      await lint(
        'const { unlinkSync, writeFileSync } = require("node:fs");\nconst path = require("node:path");\nwriteFileSync(path.join(__dirname, "baseline.json"), "changed");\nunlinkSync(__filename);\nconst shadowed = (__dirname) => writeFileSync(path.join(__dirname, "out.json"), "changed");',
      ),
    ).toEqual([3, 4]);
  });

  test("follows path operations imported under another name", async () => {
    expect(
      await lint(
        'import { mkdtempSync, writeFileSync } from "node:fs";\nimport { join as joinPath, resolve as resolvePath } from "node:path";\nconst scratch = mkdtempSync(joinPath(import.meta.dir, "scratch-"));\nwriteFileSync(joinPath(scratch, "out.json"), "data");\nwriteFileSync(joinPath(scratch, "..", "baseline.json"), "data");\nwriteFileSync(resolvePath(import.meta.dir, "/tmp/out.json"), "data");',
      ),
    ).toEqual([5]);
  });

  test("allows URLs resolved against a system temporary directory", async () => {
    expect(
      await lint(
        `import { mkdtempSync, writeFileSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport path from "node:path";\nimport { pathToFileURL } from "node:url";\nconst scratch = mkdtempSync(path.join(tmpdir(), "rule-"));\nwriteFileSync(new URL("fixture.json", pathToFileURL(scratch + "/")), "changed");`,
      ),
    ).toEqual([]);
  });

  // path.resolve discards every segment before an absolute one.
  test("allows an absolute literal resolved after a checkout path", async () => {
    expect(
      await lint(
        'import { writeFileSync } from "node:fs";\nimport path from "node:path";\nwriteFileSync(path.resolve(import.meta.dir, "/tmp/fixture.json"), "data");\nwriteFileSync(path.resolve("/tmp", import.meta.dir, "baseline.json"), "data");',
      ),
    ).toEqual([4]);
  });

  test("rejects checkout paths chosen by conditional and logical expressions", async () => {
    expect(
      await lint(
        'import { writeFile } from "node:fs/promises";\nimport { tmpdir } from "node:os";\nimport path from "node:path";\nconst temporaryFile = path.join(tmpdir(), "fixture.json");\nconst file = process.argv.length > 2 ? new URL("baseline.json", import.meta.url) : temporaryFile;\nawait writeFile(file, "changed");\nawait writeFile(process.argv[2] ?? path.join(import.meta.dir, "baseline.json"), "changed");\nawait writeFile(process.argv[2] || temporaryFile, "changed");\nawait writeFile(process.argv.length > 2 ? temporaryFile : path.join(tmpdir(), "other.json"), "changed");',
      ),
    ).toEqual([6, 7]);
  });

  test("allows traversal out of a system temporary directory", async () => {
    expect(
      await lint(
        'import { mkdtemp, writeFile } from "node:fs/promises";\nimport { tmpdir } from "node:os";\nimport path from "node:path";\nconst scratch = await mkdtemp(path.join(tmpdir(), "rule-"));\nawait writeFile(path.join(scratch, "..", "sibling"), "changed");',
      ),
    ).toEqual([]);
  });

  test("rejects checkout paths built with template literals", async () => {
    expect(
      await lint(
        `import { rm, writeFile } from "node:fs/promises";\nimport path from "node:path";\nawait rm(\`\${import.meta.dir}/fixture.json\`);\nconst checkout = path.join(import.meta.dir, "../..");\nawait writeFile(\`\${checkout}/baseline.json\`, "changed");`,
      ),
    ).toEqual([3, 5]);
  });

  test("rejects checkout paths built by string concatenation", async () => {
    expect(
      await lint(
        'import { rm, writeFile } from "node:fs/promises";\nimport path from "node:path";\nawait writeFile(import.meta.dir + "/baseline.json", "changed");\nconst checkout = path.join(import.meta.dir, "../..");\nawait rm(checkout + "/fixture.json");',
      ),
    ).toEqual([3, 5]);
  });

  test("allows a temporary path resolved after a checkout one", async () => {
    expect(
      await lint(
        'import { writeFile } from "node:fs/promises";\nimport { tmpdir } from "node:os";\nimport path from "node:path";\nawait writeFile(path.resolve(import.meta.dir, tmpdir(), "fixture.json"), "data");',
      ),
    ).toEqual([]);
  });

  test("applies last-absolute-segment resolution inside nested resolves", async () => {
    expect(
      await lint(
        'import { writeFile } from "node:fs/promises";\nimport { tmpdir } from "node:os";\nimport path from "node:path";\nawait writeFile(path.resolve(import.meta.dir, path.resolve(tmpdir(), import.meta.dir, "baseline.json")), "changed");\nawait writeFile(path.resolve(import.meta.dir, path.resolve(import.meta.dir, tmpdir(), "fixture.json")), "data");',
      ),
    ).toEqual([4]);
  });

  test("rejects appends, directory removal and truncation of checkout files", async () => {
    expect(
      await lint(
        'import { appendFileSync, rmdirSync, truncateSync } from "node:fs";\nimport path from "node:path";\nappendFileSync(new URL("baseline.json", import.meta.url), "row");\nrmdirSync(path.join(path.dirname(import.meta.filename), "fixtures"));\ntruncateSync(import.meta.path);',
      ),
    ).toEqual([3, 4, 5]);
  });

  test("checks the destination of synchronous copies", async () => {
    expect(
      await lint(
        'import { copyFileSync, cpSync, mkdtempSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport path from "node:path";\ncopyFileSync("source.json", new URL("baseline.json", import.meta.url));\ncpSync("source", path.join(import.meta.dir, "fixtures"), { recursive: true });\nconst scratch = mkdtempSync(path.join(tmpdir(), "rule-"));\ncopyFileSync(new URL("baseline.json", import.meta.url), path.join(scratch, "copy.json"));',
      ),
    ).toEqual([4, 5]);
  });

  test("allows temporary and unrelated relative paths", async () => {
    expect(
      await lint(
        'import { mkdtemp, rm, writeFile } from "node:fs/promises";\nimport { tmpdir } from "node:os";\nimport path from "node:path";\nconst scratch = await mkdtemp(path.join(tmpdir(), "rule-"));\nawait writeFile(path.join(scratch, "fixture"), "changed");\nawait rm("relative-output");',
      ),
    ).toEqual([]);
  });

  test("allows copying checkout inputs into temporary destinations", async () => {
    expect(
      await lint(
        'import { copyFile, mkdtemp } from "node:fs/promises";\nimport { tmpdir } from "node:os";\nimport path from "node:path";\nconst scratch = await mkdtemp(path.join(tmpdir(), "rule-"));\nawait copyFile(path.join(import.meta.dir, "fixture"), path.join(scratch, "copy"));',
      ),
    ).toEqual([]);
  });

  test("allows writes through the audited regeneration helper", async () => {
    expect(
      await lint(
        'import { writeRegeneratedFile } from "@stll/test-kit";\nawait writeRegeneratedFile(new URL("baseline.json", import.meta.url), "changed");',
      ),
    ).toEqual([]);
  });
});
