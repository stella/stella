import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const workflowPath = path.join(
  import.meta.dirname,
  "../.github/workflows/deploy-staging.yml",
);
const actionPath = path.join(
  import.meta.dirname,
  "../.github/actions/promote-dispatch/action.yml",
);
const leaseScriptPath = path.join(import.meta.dirname, "staging-wake.sh");
const AFTER_LEASE_HOURS = 4;
const BEFORE_LEASE_HOURS = 1;
const DEFAULT_LEASE_HOURS = 2;
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

// staging-power.yml takes the hours as a choice; the lease owner mirrors it.
const allowedLeaseHours = async (): Promise<number[]> => {
  const script = await readFile(leaseScriptPath, "utf-8");
  const declared = /^readonly allowed_lease_hours=\(([^)]*)\)$/mu.exec(
    script,
  )?.[1];
  if (declared === undefined) {
    throw new TypeError("staging-wake.sh declares no allowed lease hours");
  }
  return declared.trim().split(/\s+/u).map(Number);
};

describe("release-candidate staging power lease", () => {
  test("leases before promotion and renews before every smoke path", async () => {
    const workflow = await readFile(workflowPath, "utf-8");
    const action = await readFile(actionPath, "utf-8");
    const deploy = workflow.indexOf("name: Deploy to staging");
    const firstSmoke = workflow.indexOf(
      "name: Verify staging serves the release commit",
      deploy,
    );
    expect(workflow.slice(deploy, firstSmoke)).toContain(
      `staging-lease-before-hours: \${{ inputs.release_ref != '' && '${BEFORE_LEASE_HOURS}' || '' }}`,
    );
    expect(workflow.slice(deploy, firstSmoke)).toContain(
      `staging-lease-after-hours: \${{ inputs.release_ref != '' && '${AFTER_LEASE_HOURS}' || '' }}`,
    );
    expect(
      action.indexOf(
        `request_staging_lease "\${STAGING_LEASE_BEFORE_HOURS:-}"`,
      ),
    ).toBeLessThan(action.indexOf("/dispatches"));
    expect(
      action.indexOf(`request_staging_lease "\${STAGING_LEASE_AFTER_HOURS:-}"`),
    ).toBeGreaterThan(action.indexOf('if [[ "$conclusion" == "success" ]]'));
    expect(
      action.indexOf(`request_staging_lease "\${STAGING_LEASE_AFTER_HOURS:-}"`),
    ).toBeLessThan(
      action.indexOf(
        "exit 0",
        action.indexOf('if [[ "$conclusion" == "success" ]]'),
      ),
    );
    expect(workflow.slice(deploy, firstSmoke)).not.toContain(
      "staging-health.outputs.wake",
    );
  });

  test("the renewed lease covers every later step's declared budget", async () => {
    const workflow: unknown = Bun.YAML.parse(
      await readFile(workflowPath, "utf-8"),
    );
    const steps = field(
      field(field(workflow, "jobs"), "promote-staging"),
      "steps",
    );
    if (!Array.isArray(steps)) {
      throw new TypeError("promote-staging declares no steps");
    }
    const dispatch = steps.findIndex(
      (step) => field(step, "uses") === "./.github/actions/promote-dispatch",
    );
    const verification = steps.findIndex(
      (step) => field(step, "name") === "Record staging verification",
    );
    expect(dispatch).toBeGreaterThanOrEqual(0);
    expect(verification).toBeGreaterThan(dispatch);
    let budget = 0;
    for (const step of steps.slice(dispatch + 1, verification + 1)) {
      const minutes = field(step, "timeout-minutes");
      // An unbounded step could outlive the lease.
      expect(typeof minutes, String(field(step, "name"))).toBe("number");
      budget += Number(minutes);
    }
    expect(AFTER_LEASE_HOURS * 60).toBeGreaterThanOrEqual(budget);
    // Tight: no smaller lease staging-power.yml offers covers the budget.
    const allowed = await allowedLeaseHours();
    expect(
      allowed.filter(
        (hours) => hours < AFTER_LEASE_HOURS && hours * 60 >= budget,
      ),
    ).toEqual([]);
  });

  test("the shared lease owner only dispatches action on with the requested hours", async () => {
    const script = await readFile(leaseScriptPath, "utf-8");
    expect(script).toContain(
      `-f "inputs[action]=on" -f "inputs[hours]=\${lease_hours}"`,
    );
    expect(script).not.toContain("inputs[action]=off");
    expect(script).toContain(
      `readonly lease_hours="\${STAGING_LEASE_HOURS:-${DEFAULT_LEASE_HOURS}}"`,
    );
  });

  test("every requested lease is one staging-power.yml offers", async () => {
    const allowed = await allowedLeaseHours();
    for (const hours of [
      BEFORE_LEASE_HOURS,
      AFTER_LEASE_HOURS,
      DEFAULT_LEASE_HOURS,
    ]) {
      expect(allowed).toContain(hours);
    }
  });

  test("the lease owner refuses hours staging-power.yml does not offer", async () => {
    const run = Bun.spawn(["bash", leaseScriptPath], {
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        GH_RETRY_SCRIPT: "/nonexistent",
        GITHUB_OUTPUT: "/dev/null",
        DEPLOY_SHA: "a".repeat(40),
        STAGING_LEASE_HOURS: "3",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await run.exited).toBe(2);
    expect(await new Response(run.stderr).text()).toContain(
      "STAGING_LEASE_HOURS must be one of 1 2 4 8 (got '3')",
    );
  });
});
