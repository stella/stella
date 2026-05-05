import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("bundled Stella skill loader", () => {
  test("loads skills after bundling without a neighboring skills directory", async () => {
    const testDir = mkdtempSync(path.join(tmpdir(), "stella-skills-bundle-"));
    const entrypoint = path.join(testDir, "entrypoint.ts");
    const outfile = path.join(testDir, "entrypoint.js");

    writeFileSync(
      entrypoint,
      `import { listSkillMetadata, readSkillResource } from ${JSON.stringify(path.join(import.meta.dirname, "loader.ts"))};

const skill = listSkillMetadata().find((candidate) => candidate.name === "legal-interpretation");
if (!skill) {
  throw new Error("Bundled skill metadata missing");
}

const resource = readSkillResource({
  skillId: "legal-interpretation",
  resourcePath: "knowledge/01-interpretation-methods.md",
});
if (!resource.includes("##")) {
  throw new Error("Bundled skill resource missing");
}
`,
    );

    const build = await Bun.build({
      entrypoints: [entrypoint],
      naming: path.basename(outfile),
      outdir: testDir,
      target: "bun",
    });

    expect(build.success).toBe(true);

    const process = Bun.spawnSync({
      cmd: ["bun", outfile],
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(process.exitCode).toBe(0);
  });
});
