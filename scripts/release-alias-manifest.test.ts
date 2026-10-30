import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

const readJob = (source: unknown, name: string) => {
  const { jobs } = v.parse(
    v.object({ jobs: v.record(v.string(), v.unknown()) }),
    source,
  );
  return v.parse(
    v.object({
      if: v.optional(v.string()),
      needs: v.optional(v.union([v.string(), v.array(v.string())])),
    }),
    jobs[name],
  );
};

const readAliasStep = (source: unknown): string => {
  const { jobs } = v.parse(
    v.object({ jobs: v.record(v.string(), v.unknown()) }),
    source,
  );
  const { steps } = v.parse(
    v.object({ steps: v.array(v.record(v.string(), v.unknown())) }),
    jobs["alias-manifest"],
  );
  const run = steps.find((step) => step["id"] === "alias")?.["run"];
  if (typeof run !== "string") {
    throw new TypeError("alias-manifest has no alias step");
  }
  return run;
};

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
  const final = JSON.parse(result.stdout.toString());
  expect(final).toEqual({
    ...manifest,
    version: "v1.2.3",
    webImage: manifest.productionWebImage,
  });
  // The production promotion refuses a web image built for another target.
  expect(final.webImage.targetEnvironment).toBe("production");
  expect(final.webImage.digest).toBe(manifest.productionWebImage.digest);
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
    expect(readJob(workflow, name).if).toContain(
      "needs.resolve.outputs.channel == 'rc'",
    );
  }
  expect(readJob(workflow, "alias-manifest").if).toContain(
    "needs.resolve.outputs.channel == 'final'",
  );
  expect(readJob(workflow, "alias-manifest").needs).toBe("resolve");
  const alias = readAliasStep(workflow);
  // The dispatched web digest is the manifest entry the promotion validates.
  expect(alias).toContain(
    `web="$(jq -r '.webImage.digest' release-manifest.json)"`,
  );
  expect(alias).not.toContain(".productionWebImage.digest");
});

test("the final release attests the aliased web image under its own ref", () => {
  const workflow: unknown = Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf-8",
    ),
  );
  const { jobs } = v.parse(
    v.object({ jobs: v.record(v.string(), v.unknown()) }),
    workflow,
  );
  const job = v.parse(
    v.object({
      permissions: v.record(v.string(), v.string()),
      steps: v.array(v.record(v.string(), v.unknown())),
    }),
    jobs["alias-manifest"],
  );
  expect(job.permissions["id-token"]).toBe("write");
  expect(job.permissions["attestations"]).toBe("write");
  const names = job.steps.map((step) => step["name"]);
  const attests = job.steps.filter(
    (step) =>
      typeof step["uses"] === "string" &&
      step["uses"].startsWith("actions/attest@"),
  );
  // One publication attestation per aliased image the promotion verifies,
  // retried, never skipped on the first attempt.
  expect(attests.length).toBe(3);
  for (const step of attests) {
    expect(step["with"]).toEqual({
      "subject-name": `\${{ env.REGISTRY }}/\${{ env.WEB_IMAGE_NAME }}`,
      "subject-digest": `\${{ steps.alias.outputs.web }}`,
      "predicate-type": `\${{ env.WEB_PUBLICATION_PREDICATE }}`,
      "predicate-path": "web-image-publication.json",
      "push-to-registry": true,
    });
  }
  expect(attests.at(0)?.["if"]).toBeUndefined();
  const predicate = job.steps.find(
    (step) => step["name"] === "Write web image publication predicate",
  );
  expect(predicate?.["env"]).toEqual({
    RELEASE_REF: `\${{ needs.resolve.outputs.release_ref }}`,
    RELEASE_SHA: `\${{ needs.resolve.outputs.release_sha }}`,
    TARGET_ENV: `\${{ steps.alias.outputs.web_target }}`,
  });
  // Attested before the job logs out of the registry the attestation goes to.
  expect(names.indexOf("Attest web image publication")).toBeGreaterThan(
    names.indexOf("Alias RC digests and release assets"),
  );
  expect(names.indexOf("Log out of GitHub Container Registry")).toBeGreaterThan(
    names.indexOf("Attest web image publication (final retry)"),
  );
  for (const name of [
    "publish-release",
    "publish-latest",
    "dispatch-release-health",
  ]) {
    expect(readJob(workflow, name).needs).toContain("promote-production");
  }
});
