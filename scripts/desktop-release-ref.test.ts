import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// CI runs this file in "Test release policy scripts" without the dependency
// install, so it reads workflow shapes by hand.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A workflow `${{ … }}` expression, as the parsed YAML holds it. */
const githubExpression = (inner: string) => `\${{ ${inner} }}`;

const script = path.resolve(import.meta.dir, "desktop-release-ref.sh");
const work = mkdtempSync(path.join(tmpdir(), "desktop-release-ref-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

// Stands in for scripts/gh-retry.sh: answers every API call with the
// fixture and records the arguments it was called with.
const stub = path.join(work, "gh-retry.sh");
writeFileSync(
  stub,
  `printf '%s\\n' "$*" >> "$CALLS"\nprintf '%s' "$ARTIFACTS"\n`,
);

type ResolveOptions = {
  releaseInput?: string;
  upstreamRunId?: string;
  artifacts?: readonly string[];
};
const resolve = ({
  releaseInput = "",
  upstreamRunId = "",
  artifacts = [],
}: ResolveOptions) => {
  const calls = path.join(work, `calls-${crypto.randomUUID()}`);
  writeFileSync(calls, "");
  const result = Bun.spawnSync(["bash", script, releaseInput, upstreamRunId], {
    env: {
      ...process.env,
      ARTIFACTS: JSON.stringify({
        total_count: artifacts.length,
        artifacts: artifacts.map((name) => ({ name })),
      }),
      CALLS: calls,
      GH_RETRY_SCRIPT: stub,
      GITHUB_REPOSITORY: "stella/stella",
    },
  });
  return {
    exit: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    calls: readFileSync(calls, "utf-8"),
  };
};

// What Release Artifacts uploads next to its manifest.
const releaseRunArtifacts = (tag: string) => [
  "release-notes",
  `release-manifest-${tag}`,
  "web-build-report",
];

describe("desktop release ref", () => {
  test("a manual dispatch publishes the tag it names, without reading any run", () => {
    const result = resolve({ releaseInput: "v1.2.3", upstreamRunId: "" });
    expect(result).toMatchObject({ exit: 0, stdout: "v1.2.3\n", calls: "" });
  });

  // A tag-push run and a dispatched run look the same here on purpose: the
  // dispatched run reports main as its branch, so only its manifest names
  // the tag.
  for (const [trigger, tag] of [
    ["tag push", "v1.2.3"],
    ["dispatched from main", "v1.2.4-rc.1"],
  ] as const) {
    test(`a Release Artifacts run started by ${trigger} publishes its manifest's tag`, () => {
      const result = resolve({
        upstreamRunId: "39945408543",
        artifacts: releaseRunArtifacts(tag),
      });
      expect(result.exit).toBe(0);
      expect(result.stdout).toBe(`${tag}\n`);
      expect(result.calls).toBe(
        "api repos/stella/stella/actions/runs/39945408543/artifacts?per_page=100\n",
      );
    });
  }

  test("refuses a run without exactly one release manifest", () => {
    for (const [artifacts, manifests] of [
      [["release-notes"], 0],
      [["release-manifest-v1.2.3", "release-manifest-v1.2.4"], 2],
    ] as const) {
      const result = resolve({ upstreamRunId: "7", artifacts });
      expect(result.exit, artifacts.join(",")).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        `has ${String(manifests)} release-manifest artifacts`,
      );
    }
  });

  test("refuses to run without an input or an upstream run id", () => {
    for (const upstreamRunId of ["", "main", "7 8"]) {
      const result = resolve({ upstreamRunId });
      expect(result.exit, upstreamRunId).toBe(1);
      expect(result.calls).toBe("");
    }
  });
});

describe("release workflows name runs by tag", () => {
  const workflow = (file: string): Record<string, unknown> => {
    const parsed: unknown = Bun.YAML.parse(
      readFileSync(
        new URL(`../.github/workflows/${file}`, import.meta.url),
        "utf-8",
      ),
    );
    expect(isRecord(parsed), file).toBe(true);
    return isRecord(parsed) ? parsed : {};
  };
  const releaseDesktop = workflow("release-desktop.yml");
  const release = workflow("release.yml");

  test("Release Desktop App never reads the upstream run's branch", () => {
    expect(JSON.stringify(releaseDesktop)).not.toContain(
      "workflow_run.head_branch",
    );
    const jobs = isRecord(releaseDesktop["jobs"]) ? releaseDesktop["jobs"] : {};
    const resolveJob = isRecord(jobs["resolve"]) ? jobs["resolve"] : {};
    const steps = Array.isArray(resolveJob["steps"]) ? resolveJob["steps"] : [];
    const resolveStep = steps.find(
      (step: unknown) => isRecord(step) && step["id"] === "ref",
    );
    expect(isRecord(resolveStep) ? resolveStep["run"] : "").toContain(
      'REF=$(bash scripts/desktop-release-ref.sh "$RELEASE_INPUT" "$UPSTREAM_RUN_ID")',
    );
  });

  // retry.sh makes three attempts with 15 s and 45 s pauses; an uncached
  // Windows install has taken up to 9 min, macOS about 30 s.
  test("the install deadline leaves room for every retry on each runner OS", () => {
    const jobs = isRecord(releaseDesktop["jobs"]) ? releaseDesktop["jobs"] : {};
    const build = isRecord(jobs["build"]) ? jobs["build"] : {};
    const steps = Array.isArray(build["steps"]) ? build["steps"] : [];
    const install = steps.find(
      (step: unknown) =>
        isRecord(step) && step["name"] === "Install dependencies",
    );
    expect(isRecord(install) ? install["timeout-minutes"] : undefined).toBe(
      githubExpression("matrix.os == 'windows' && 30 || 5"),
    );
    const retryBudgetMinutes = (worstAttemptMinutes: number) =>
      3 * worstAttemptMinutes + (15 + 45) / 60;
    expect(retryBudgetMinutes(9)).toBeLessThanOrEqual(30);
    expect(retryBudgetMinutes(0.5)).toBeLessThanOrEqual(5);
  });

  // scripts/check-desktop-release-policy.sh matches runs by these names.
  test("run names carry the tag on every trigger", () => {
    expect(release["run-name"]).toBe(
      `Release Artifacts ${githubExpression("github.event_name == 'workflow_dispatch' && inputs.release_ref || github.ref_name")}`,
    );
    expect(releaseDesktop["run-name"]).toBe(
      `Desktop ${githubExpression("inputs.release_ref && format('Release Artifacts {0}', inputs.release_ref) || github.event.workflow_run.display_title")}`,
    );
    const policy = readFileSync(
      path.resolve(import.meta.dir, "check-desktop-release-policy.sh"),
      "utf-8",
    );
    expect(policy).toContain(`run_title="Release Artifacts \${newest_tag}"`);
    expect(policy).toContain(
      `run_title="Desktop Release Artifacts \${newest_tag}"`,
    );
  });
});
