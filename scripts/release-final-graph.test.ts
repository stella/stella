import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// A final release aliases the candidate's artifacts instead of building
// them, so every receipt and artifact a downstream consumer reads must come
// out of the alias path exactly as it did out of the build path.
const WORKFLOWS = path.join(import.meta.dir, "../.github/workflows");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readWorkflow = (file: string): Record<string, unknown> => {
  const parsed: unknown = Bun.YAML.parse(
    readFileSync(path.join(WORKFLOWS, file), "utf-8"),
  );
  if (!isRecord(parsed) || !isRecord(parsed["jobs"])) {
    throw new TypeError(`${file} declares no jobs`);
  }
  return parsed["jobs"];
};

const stepsOf = (job: unknown): Record<string, unknown>[] =>
  isRecord(job) && Array.isArray(job["steps"])
    ? job["steps"].filter(isRecord)
    : [];

const uploadedArtifacts = (job: unknown): string[] =>
  stepsOf(job).flatMap((step) =>
    typeof step["uses"] === "string" &&
    step["uses"].startsWith("actions/upload-artifact@") &&
    isRecord(step["with"]) &&
    typeof step["with"]["name"] === "string" &&
    // Failure diagnostics are not receipts.
    step["if"] !== "failure()"
      ? [step["with"]["name"]]
      : [],
  );

/** Every image registry read in a step, with the step's position. */
const registryReads = (job: unknown): number[] =>
  stepsOf(job).flatMap((step, index) =>
    typeof step["run"] === "string" &&
    step["run"].includes("imagetools inspect")
      ? [index]
      : [],
  );

const registryLogins = (job: unknown): number[] =>
  stepsOf(job).flatMap((step, index) =>
    typeof step["uses"] === "string" &&
    step["uses"].startsWith("docker/login-action@")
      ? [index]
      : [],
  );

describe("final release on the alias path", () => {
  const jobs = readWorkflow("release.yml");

  test("uploads every artifact the build path's manifest job uploads", () => {
    const built = uploadedArtifacts(jobs["manifest"]);
    expect(built).toContain(
      `release-manifest-\${{ needs.resolve.outputs.release_ref }}`,
    );
    const aliased = new Set(uploadedArtifacts(jobs["alias-manifest"]));
    expect(built.filter((name) => !aliased.has(name))).toEqual([]);
  });

  test("Release Desktop finds the manifest artifact by the prefix both paths upload", () => {
    const reader = readFileSync(
      path.join(import.meta.dir, "desktop-release-ref.sh"),
      "utf-8",
    );
    expect(reader).toContain('select(startswith("release-manifest-"))');
    for (const job of ["manifest", "alias-manifest"]) {
      expect(
        uploadedArtifacts(jobs[job]).some((name) =>
          name.startsWith("release-manifest-"),
        ),
      ).toBe(true);
    }
  });

  test("every job output another job reads is declared by the job it names", () => {
    const source = readFileSync(path.join(WORKFLOWS, "release.yml"), "utf-8");
    const missing = [
      ...source.matchAll(/needs\.([\w-]+)\.outputs\.([\w-]+)/gu),
    ].flatMap(([reference, job, output]) => {
      if (job === undefined || output === undefined) {
        return [reference];
      }
      const declared = jobs[job];
      return isRecord(declared) &&
        isRecord(declared["outputs"]) &&
        output in declared["outputs"]
        ? []
        : [reference];
    });
    expect([...new Set(missing)]).toEqual([]);
  });
});

describe("registry reads", () => {
  test("every job that inspects a registry image logs in to the registry first", () => {
    const unauthenticated = readdirSync(WORKFLOWS)
      .filter((file) => file.endsWith(".yml"))
      .flatMap((file) =>
        Object.entries(readWorkflow(file)).flatMap(([name, job]) => {
          const reads = registryReads(job);
          const firstLogin = registryLogins(job).at(0);
          return reads.length > 0 &&
            (firstLogin === undefined ||
              reads.some((read) => read < firstLogin))
            ? [`${file}/${name}`]
            : [];
        }),
      );
    expect(unauthenticated).toEqual([]);
  });
});
