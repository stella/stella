import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const sha = "a".repeat(40);
const image = (hex: string, targetEnvironment?: string) => ({
  name: "ghcr.io/stella/image",
  digest: `sha256:${hex.repeat(64)}`,
  reference: `ghcr.io/stella/image@sha256:${hex.repeat(64)}`,
  ...(targetEnvironment ? { targetEnvironment } : {}),
});
test("stable manifest preserves every RC image identity and the proven SHA", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "release-alias-"));
  const manifest = {
    version: "v1.2.3-rc.4",
    commit: sha,
    image: image("a"),
    webImage: image("b", "staging"),
    productionWebImage: image("c", "production"),
  };
  const file = path.join(dir, "rc.json");
  writeFileSync(file, JSON.stringify(manifest));
  const run = (target: string) =>
    Bun.spawnSync([
      "bash",
      path.join(import.meta.dir, "alias-release-manifest.sh"),
      file,
      "v1.2.3",
      target,
    ]);
  const result = run(sha);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({
    ...manifest,
    version: "v1.2.3",
  });
  expect(run("b".repeat(40)).exitCode).not.toBe(0);
  rmSync(dir, { recursive: true, force: true });
});

test("final release declares no build, smoke, or web-image work", () => {
  const workflow = Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf-8",
    ),
  );
  for (const name of [
    "build",
    "smoke",
    "prepare-web-image",
    "prepare-production-web-image",
    "prove-production-web-image",
  ]) {
    expect(workflow.jobs[name].if).toContain(
      "needs.resolve.outputs.channel == 'rc'",
    );
  }
  expect(workflow.jobs["alias-manifest"].if).toContain(
    "needs.resolve.outputs.channel == 'final'",
  );
  expect(workflow.jobs["alias-manifest"].needs).toBe("resolve");
  for (const name of [
    "publish-release",
    "publish-latest",
    "dispatch-release-health",
  ]) {
    expect(workflow.jobs[name].needs).toContain("promote-production");
  }
});
