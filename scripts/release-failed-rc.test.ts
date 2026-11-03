import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { finalize } from "./release-finalize.fixture";

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;
const read = (file: string) =>
  readFileSync(
    new URL(`../.github/workflows/${file}`, import.meta.url),
    "utf-8",
  );

test("a red heavy RC leaves the stable tag and draft prerelease untouched", () => {
  const proof = finalize({ states: { "main/heavy": "failure" } });
  expect(proof.result.exitCode).not.toBe(0);
  expect(proof.finalSha).toBeNull();
  expect(proof.pushes).toBe("");
  expect(proof.publications).toBe("");
});

test("mutable production image pointers and publication require production promotion", () => {
  const workflow: unknown = Bun.YAML.parse(read("release.yml"));
  const jobs = field(workflow, "jobs");
  for (const name of [
    "publish-release",
    "publish-latest",
    "dispatch-release-health",
  ]) {
    const needs = field(field(jobs, name), "needs");
    expect(Array.isArray(needs) ? needs : [needs]).toContain(
      "promote-production",
    );
  }
  const staging = field(jobs, "promote-staging");
  expect(JSON.stringify(staging)).not.toContain("--draft=false");
  expect(JSON.stringify(staging)).not.toContain(":latest");
});

test("the npm stable publisher cannot consume an RC artifact run", () => {
  const workflow = read("publish-npm.yml");
  // The source guard resolves only a final ref from a successful production job.
  expect(workflow).toContain("check-release-publication-source.sh");
  const guard = readFileSync(
    new URL("check-release-publication-source.sh", import.meta.url),
    "utf-8",
  );
  expect(guard).toContain("promote-production");
  expect(guard).toContain("^v[0-9]+");
  expect(guard).toContain('[[ "$release_ref" != *-* ]]');
});

// The Actions jobs API reports a job's display name, which is its `name:`
// when one is declared and its job id otherwise. The publication guard
// matches `promote-production`, so that job must keep reporting exactly that.
test("the production promotion job reports the name the publication guard matches", () => {
  const guard = readFileSync(
    new URL("check-release-publication-source.sh", import.meta.url),
    "utf-8",
  );
  const matched = /^job=(\S+)$/mu.exec(guard)?.[1];
  expect(matched).toBe("promote-production");
  if (matched === undefined) {
    throw new TypeError(
      "Publication guard must name the production promotion job",
    );
  }
  const workflow: unknown = Bun.YAML.parse(read("release.yml"));
  const job = field(field(workflow, "jobs"), "promote-production");
  expect(job).toBeDefined();
  const name = field(job, "name");
  if (name !== undefined && typeof name !== "string") {
    throw new TypeError("Promotion job display name must be a string");
  }
  const displayName = name ?? "promote-production";
  expect(displayName).toBe(matched);
});
