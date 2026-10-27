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
      `staging-lease-before-hours: \${{ inputs.release_ref != '' && '8' || '' }}`,
    );
    expect(workflow.slice(deploy, firstSmoke)).toContain(
      `staging-lease-after-hours: \${{ inputs.release_ref != '' && '2' || '' }}`,
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

  test("lease hours cover the declared following step budgets", async () => {
    const workflow = await readFile(workflowPath, "utf-8");
    const promote = workflow.slice(
      workflow.indexOf("name: Deploy to staging"),
      workflow.indexOf("name: Record staging deployment"),
    );
    expect(promote).toContain("timeout-minutes: 350");
    expect(8 * 60).toBeGreaterThanOrEqual(350 + 10 + 5 + 2 + 4 + 2 + 20 + 40);
    expect(2 * 60).toBeGreaterThanOrEqual(10 + 5 + 2 + 4 + 2 + 20 + 40);
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
