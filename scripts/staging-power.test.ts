import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

const WORKFLOW = new URL(
  "../.github/workflows/deploy-staging.yml",
  import.meta.url,
);
const ACTION_PATH = path.resolve(
  import.meta.dir,
  "../.github/actions/staging-power",
);

const workflowSchema = v.object({
  concurrency: v.object({
    group: v.literal("deploy-staging"),
    "cancel-in-progress": v.literal(false),
  }),
  jobs: v.record(
    v.string(),
    v.object({
      needs: v.optional(v.union([v.string(), v.array(v.string())])),
      if: v.optional(v.string()),
      concurrency: v.optional(v.unknown()),
      steps: v.array(
        v.object({
          name: v.string(),
          uses: v.optional(v.string()),
          if: v.optional(v.string()),
          run: v.optional(v.string()),
          env: v.optional(v.record(v.string(), v.string())),
          with: v.optional(v.record(v.string(), v.unknown())),
        }),
      ),
    }),
  ),
});

const assertLifecycle = (source: unknown) => {
  const workflow = v.parse(workflowSchema, source);
  const cleanup = workflow.jobs["staging-power-off"];
  const health = workflow.jobs["staging-health"];
  expect(cleanup).toBeDefined();
  expect(health).toBeDefined();
  if (!cleanup || !health) {
    throw new Error("Missing staging lifecycle job");
  }
  expect(cleanup.needs).toEqual(
    Object.keys(workflow.jobs).filter((name) => name !== "staging-power-off"),
  );
  expect(cleanup.if).toBe(
    `\${{ always() && needs.staging-health.result != 'skipped' }}`,
  );
  const acquire = health.steps.findIndex(
    (step) => step.with?.["action"] === "on",
  );
  const probe = health.steps.findIndex(
    (step) => step.name === "Probe staging health",
  );
  expect(acquire).toBeGreaterThanOrEqual(0);
  expect(probe).toBeGreaterThan(acquire);
  expect(health.steps[acquire]?.uses).toBe("./.github/actions/staging-power");
  const release = cleanup.steps.at(-1);
  expect(release?.uses).toBe("./.github/actions/staging-power");
  expect(release?.with?.["action"]).toBe("off");
  expect(release?.if).toBe("always()");
  // A job must never wait on the workflow's own concurrency group.
  for (const job of Object.values(workflow.jobs)) {
    expect(job.concurrency).not.toEqual(workflow.concurrency);
  }
};

test("overlapping staging pipelines serialize acquisition through final release", async () => {
  const source = await Bun.file(WORKFLOW).text();
  assertLifecycle(Bun.YAML.parse(source));
  for (const mutation of [
    source.replace("  cancel-in-progress: false", "  cancel-in-progress: true"),
    source.replace(
      "group: deploy-staging",
      `group: deploy-staging-\${{ github.run_id }}`,
    ),
    source.replace(
      "build-api, build-web, promote-staging]",
      "build-api, build-web]",
    ),
    source.replace(
      "always() && needs.staging-health.result",
      "success() && needs.staging-health.result",
    ),
    source.replace('action: "off"', 'action: "on"'),
  ]) {
    expect(mutation).not.toBe(source);
    expect(() => assertLifecycle(Bun.YAML.parse(mutation))).toThrow(
      /Invalid|expect/u,
    );
  }
});

test("every lease consumer rejects a partial rerun before doing work", async () => {
  const workflow = v.parse(
    workflowSchema,
    Bun.YAML.parse(await Bun.file(WORKFLOW).text()),
  );
  const consumers = Object.entries(workflow.jobs).filter(
    ([name, job]) =>
      name !== "staging-power-off" &&
      Array.isArray(job.needs) &&
      job.needs.includes("staging-health"),
  );
  expect(consumers.map(([name]) => name)).toEqual([
    "build-api",
    "build-web",
    "promote-staging",
  ]);
  for (const [, job] of consumers) {
    const step = job.steps.at(0);
    expect(step?.env?.["LEASE_ATTEMPT"]).toBe(
      `\${{ needs.staging-health.outputs.lease-attempt }}`,
    );
    if (!step?.run) {
      throw new Error("Missing lease attempt check");
    }
    for (const attempt of ["1", "2"]) {
      const result = Bun.spawnSync(["bash", "-c", step.run], {
        env: {
          ...process.env,
          LEASE_ATTEMPT: "1",
          GITHUB_RUN_ATTEMPT: attempt,
        },
      });
      expect(result.exitCode).toBe(attempt === "1" ? 0 : 1);
      if (attempt === "2") {
        expect(result.stdout.toString()).toContain("Rerun all jobs");
      }
    }
  }
});

const FAKE_GH = `#!/usr/bin/env python3
import json,os,pathlib,sys
args=sys.argv[1:]
endpoint=next((arg for arg in args if arg.startswith('/')), '')
data=sys.stdin.read()
root=pathlib.Path(os.environ['FIXTURE_ROOT'])
with (root/'calls').open('a') as f: f.write(json.dumps({'args':args,'body':data})+'\\n')
if endpoint.endswith('/installation'): print(123)
elif endpoint.endswith('/access_tokens'): print('fixture-token')
elif endpoint.endswith('/dispatches'):
 fields=dict(args[i+1].split('=',1) for i,arg in enumerate(args) if arg=='-f')
 (root/'dispatch').write_text(json.dumps(fields))
elif '/runs?' in endpoint:
 fields=json.loads((root/'dispatch').read_text())
 title='Staging power '+fields['inputs[action]']+' '+fields['inputs[lease_id]']
 matches=[{'id':777,'display_title':title,'created_at':'2999-01-01T00:00:00Z'},
          {'id':888,'display_title':title+'-other','created_at':'2999-01-01T00:00:00Z'}]
 if os.environ['SCENARIO']=='ambiguous': matches.append(matches[0])
 print(json.dumps([{'workflow_runs':matches}]))
elif '/runs/777' in endpoint:
 scenario=os.environ['SCENARIO']
 if scenario=='lookup-error': sys.exit(23)
 print(json.dumps({'status':'completed','conclusion':scenario if scenario in ['failure','cancelled'] else 'success'}))
elif endpoint=='/installation/token': pass
else: raise RuntimeError('Unexpected endpoint '+endpoint)
`;

type ScenarioOptions = {
  action: "on" | "off";
  runId?: string;
  attempt?: string;
  scenario?: string;
};
const dispatch = async ({
  action,
  runId = "42",
  attempt = "1",
  scenario = "success",
}: ScenarioOptions) => {
  const directory = await mkdtemp(path.join(tmpdir(), "staging-power-"));
  try {
    for (const [name, body] of Object.entries({
      gh: FAKE_GH,
      openssl:
        "#!/usr/bin/env bash\ncat >/dev/null\nprintf fixture-signature\n",
    })) {
      const executable = path.join(directory, name);
      await Bun.write(executable, body);
      await chmod(executable, 0o700);
    }
    const result = Bun.spawn(["bash", path.join(ACTION_PATH, "dispatch.sh")], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env["PATH"] ?? ""}`,
        GITHUB_ACTION_PATH: ACTION_PATH,
        FIXTURE_ROOT: directory,
        SCENARIO: scenario,
        INFRA_REPO: "example/infra",
        POWER_ACTION: action,
        APP_CLIENT_ID: "fixture-app",
        APP_PRIVATE_KEY: "fixture-key",
        GITHUB_REPOSITORY: "example/app",
        GITHUB_RUN_ID: runId,
        GITHUB_RUN_ATTEMPT: attempt,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([
      result.exited,
      new Response(result.stdout).text(),
      new Response(result.stderr).text(),
    ]);
    return {
      exit,
      stdout,
      stderr,
      payload: v.parse(
        v.record(v.string(), v.string()),
        await Bun.file(path.join(directory, "dispatch")).json(),
      ),
      calls: await Bun.file(path.join(directory, "calls")).text(),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("acquire and release use the same scoped lease while overlapping callers and reruns differ", async () => {
  const acquired = await dispatch({ action: "on" });
  const released = await dispatch({ action: "off" });
  const overlapping = await dispatch({ action: "on", runId: "43" });
  const rerun = await dispatch({ action: "on", attempt: "2" });
  for (const result of [acquired, released, overlapping, rerun]) {
    expect(result.exit).toBe(0);
    expect(result.calls).toContain('"/installation/token"');
    expect(result.calls).toContain('"/repos/example/infra/actions/runs/777"');
    expect(result.calls).not.toContain(
      '"/repos/example/infra/actions/runs/888"',
    );
    expect(result.payload["inputs[fallback_minutes]"]).toBe("30");
    expect(result.payload["inputs[caller_repository]"]).toBe("example/app");
  }
  expect(acquired.payload["inputs[lease_id]"]).toBe("example/app:42:1");
  expect(released.payload["inputs[lease_id]"]).toBe(
    acquired.payload["inputs[lease_id]"],
  );
  expect(overlapping.payload["inputs[lease_id]"]).not.toBe(
    acquired.payload["inputs[lease_id]"],
  );
  expect(rerun.payload["inputs[lease_id]"]).not.toBe(
    acquired.payload["inputs[lease_id]"],
  );
});

test.each(["failure", "cancelled", "lookup-error", "ambiguous"])(
  "power %s cannot authorize deployment",
  async (scenario) => {
    const result = await dispatch({ action: "on", scenario });
    expect(result.exit).not.toBe(0);
    expect(result.calls).toContain('"/installation/token"');
  },
);
