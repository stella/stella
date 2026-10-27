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
const AFTER_LEASE_HOURS = 3;
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

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
      `staging-lease-before-hours: \${{ inputs.release_ref != '' && '1' || '' }}`,
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
    // Tight: one hour less would no longer cover the budget.
    expect((AFTER_LEASE_HOURS - 1) * 60).toBeLessThan(budget);
  });

  test("the shared lease owner only dispatches action on with the requested hours", async () => {
    const script = await readFile(leaseScriptPath, "utf-8");
    expect(script).toContain(
      `-f "inputs[action]=on" -f "inputs[hours]=\${lease_hours}"`,
    );
    expect(script).not.toContain("inputs[action]=off");
    expect(script).toContain(
      `readonly lease_hours="\${STAGING_LEASE_HOURS:-2}"`,
    );
  });
});
