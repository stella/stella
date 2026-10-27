import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const script = path.join(import.meta.dirname, "staging-owner.sh");
const workflowPath = path.join(
  import.meta.dirname,
  "../.github/workflows/deploy-staging.yml",
);
const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces
      .splice(0)
      .map(async (workspace) =>
        rm(workspace, { recursive: true, force: true }),
      ),
  );
});

const runGate = async (mode: "candidate" | "ordinary", fixture: unknown) => {
  const workspace = await mkdtemp(path.join(tmpdir(), "staging-owner-"));
  workspaces.push(workspace);
  const retry = path.join(workspace, "gh-retry.sh");
  await writeFile(
    retry,
    `#!/usr/bin/env bash\nset -euo pipefail\nfixture='${path.join(workspace, "fixture.json")}'\nif [[ "$2" == */jobs* ]]; then jq -r "$4" "$fixture"; else jq -r "$4" "$fixture"; fi\n`,
  );
  await writeFile(
    path.join(workspace, "fixture.json"),
    JSON.stringify(fixture),
  );
  await chmod(retry, 0o755);
  const process = Bun.spawn(["bash", script], {
    env: {
      ...processEnv(),
      GH_RETRY_SCRIPT: retry,
      GITHUB_REPOSITORY: "stella/stella",
      GITHUB_RUN_ID: "99",
      STAGING_OWNER_MODE: mode,
      STAGING_OWNER_ATTEMPTS: "1",
      STAGING_OWNER_INTERVAL_SECONDS: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: await process.exited,
    stderr: await new Response(process.stderr).text(),
  };
};

const processEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

describe("staging promotion ownership", () => {
  for (const status of ["queued", "in_progress"]) {
    test(`ordinary promotion waits while a candidate is ${status}`, async () => {
      const result = await runGate("ordinary", {
        workflow_runs: [
          {
            id: 1,
            display_title: "Staging release proof v1.2.3-rc.1 abc",
            status,
          },
        ],
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Timed out waiting for a release-candidate staging proof",
      );
    });
  }

  test("ordinary promotion passes when no candidate owns staging", async () => {
    expect(
      (
        await runGate("ordinary", {
          workflow_runs: [
            {
              id: 1,
              display_title: "Deploy main to staging abc",
              status: "in_progress",
            },
          ],
        })
      ).exitCode,
    ).toBe(0);
  });

  test("candidate waits for an ordinary promote in progress", async () => {
    const result = await runGate("candidate", {
      workflow_runs: [
        {
          id: 1,
          display_title: "Deploy main to staging abc",
          status: "in_progress",
        },
      ],
      jobs: [{ name: "Promote staging images", status: "in_progress", id: 2 }],
    });
    expect(result.exitCode).toBe(1);
  });

  for (const mode of ["candidate", "ordinary"] as const) {
    test(`${mode} promotion refuses when ownership cannot be read`, async () => {
      // A string has no workflow_runs, so the fixture reader fails.
      const result = await runGate(mode, "unreadable");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Reading staging ownership failed");
    });
  }

  test("each gate waits at least as long as the owner it waits for may run", async () => {
    const source = await readFile(script, "utf-8");
    const workflow: unknown = Bun.YAML.parse(
      await readFile(workflowPath, "utf-8"),
    );
    const field = (value: unknown, key: string): unknown =>
      typeof value === "object" && value !== null
        ? Reflect.get(value, key)
        : undefined;
    const steps = field(
      field(field(workflow, "jobs"), "promote-staging"),
      "steps",
    );
    if (!Array.isArray(steps)) {
      throw new TypeError("promote-staging declares no steps");
    }
    const gate: unknown = steps.find(
      (step) => field(step, "name") === "Wait for the current staging owner",
    );
    const attempts = [...source.matchAll(/default_attempts=(\d+)/gu)].map(
      ([, value]) => Number(value),
    );
    const interval = Number(
      /STAGING_OWNER_INTERVAL_SECONDS:-(\d+)/u.exec(source)?.[1],
    );
    expect(attempts).toHaveLength(2);
    // The step outlives the longest wait, so the script names the timeout.
    expect(Number(field(gate, "timeout-minutes")) * 60).toBeGreaterThan(
      Math.max(...attempts) * interval,
    );
  });

  test("workflow separates owners and gates each before dispatch", async () => {
    const workflow = await readFile(workflowPath, "utf-8");
    expect(workflow).toContain(
      "inputs.release_ref != '' && 'deploy-staging-candidate' || 'deploy-staging-ordinary'",
    );
    expect(workflow).toContain("cancel-in-progress: false");
    expect(
      workflow.indexOf("name: Wait for the current staging owner"),
    ).toBeLessThan(workflow.indexOf("name: Deploy to staging"));
    expect(workflow).toContain(
      `STAGING_OWNER_MODE: \${{ inputs.release_ref != '' && 'candidate' || 'ordinary' }}`,
    );
  });
});
