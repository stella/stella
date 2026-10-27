import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const ARTIFACT = "e2e-web-build";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const waitStep = (): string => {
  const action: unknown = Bun.YAML.parse(
    readFileSync(
      path.join(ROOT, ".github/actions/marketing-capture/action.yml"),
      "utf-8",
    ),
  );
  const runs = isRecord(action) ? action["runs"] : undefined;
  const steps = isRecord(runs) ? runs["steps"] : undefined;
  const step = (Array.isArray(steps) ? steps : []).find(
    (candidate) =>
      isRecord(candidate) &&
      typeof candidate["run"] === "string" &&
      candidate["run"].includes("/actions/runs/$GITHUB_RUN_ID/artifacts"),
  );
  if (!isRecord(step) || typeof step["run"] !== "string") {
    throw new Error("marketing-capture has no artifact wait step");
  }
  return step["run"];
};

/** ci.yml jobs whose steps upload the production web build artifact. */
const producerJobs = (): string[] => {
  const workflow: unknown = Bun.YAML.parse(
    readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf-8"),
  );
  const jobs = isRecord(workflow) ? workflow["jobs"] : undefined;
  return Object.entries(isRecord(jobs) ? jobs : {})
    .filter(([, job]) => {
      const steps = isRecord(job) ? job["steps"] : undefined;
      return (Array.isArray(steps) ? steps : []).some(
        (step) =>
          isRecord(step) &&
          typeof step["uses"] === "string" &&
          step["uses"].startsWith("actions/upload-artifact@") &&
          isRecord(step["with"]) &&
          step["with"]["name"] === ARTIFACT,
      );
    })
    .map(([id, job]) =>
      isRecord(job) && typeof job["name"] === "string" ? job["name"] : id,
    )
    .toSorted();
};

test("the wait step watches every job that publishes the web build", () => {
  const watched = [...waitStep().matchAll(/\.name == "([^"]+)"/gu)]
    .map((match) => match[1] ?? "")
    .toSorted();
  expect(producerJobs().length).toBeGreaterThan(1);
  expect(watched).toEqual(producerJobs());
});

const runWait = (conclusions: readonly string[]) => {
  const directory = mkdtempSync(path.join(tmpdir(), "marketing-wait-"));
  try {
    const actionPath = path.join(directory, "a", "b", "c");
    mkdirSync(actionPath, { recursive: true });
    mkdirSync(path.join(directory, "scripts"));
    const stub = path.join(directory, "scripts", "gh-retry.sh");
    writeFileSync(
      stub,
      [
        "#!/usr/bin/env bash",
        'if [[ "$*" == *"/artifacts"* ]]; then echo 0; else printf "%s\\n" "$CONCLUSIONS"; fi',
      ].join("\n"),
    );
    chmodSync(stub, 0o755);
    const result = Bun.spawnSync(
      ["bash", "-eo", "pipefail", "-c", `sleep() { :; }\n${waitStep()}`],
      {
        env: {
          ...process.env,
          ARTIFACT_NAME: ARTIFACT,
          CONCLUSIONS: conclusions.join("\n"),
          GITHUB_ACTION_PATH: actionPath,
          GITHUB_REPOSITORY: "acme/repo",
          GITHUB_RUN_ID: "1",
        },
        stdout: "pipe",
      },
    );
    return { exitCode: result.exitCode, output: result.stdout.toString() };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test("a skipped web-build does not end the wait while heavy-web-build runs", () => {
  const result = runWait(["skipped", "in_progress"]);
  expect(result.output).not.toContain("Every web build job ended");
  expect(result.output).toContain("artifact was not published");
  expect(result.exitCode).toBe(1);
});

test("the wait ends early once every web build job ended without success", () => {
  const result = runWait(["skipped", "failure"]);
  expect(result.output).toContain(
    "Every web build job ended (skipped failure)",
  );
  expect(result.exitCode).toBe(1);
});
