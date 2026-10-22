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

const POWER_DISPATCH_TIMEOUT_MS = 15_000;

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
      "timeout-minutes": v.optional(v.number()),
      steps: v.array(
        v.object({
          name: v.string(),
          uses: v.optional(v.string()),
          if: v.optional(v.string()),
          run: v.optional(v.string()),
          env: v.optional(v.record(v.string(), v.string())),
          "timeout-minutes": v.optional(v.number()),
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
  expect(health.steps[acquire]?.with?.["lease-attempt"]).toBe(
    `\${{ github.run_attempt }}`,
  );
  const release = cleanup.steps.at(-1);
  expect(release?.uses).toBe("./.github/actions/staging-power");
  expect(release?.with?.["action"]).toBe("off");
  expect(release?.if).toBe("always()");
  // A rerun of only the failed cleanup runs in a later attempt; it must
  // release the lease the acquiring attempt took.
  expect(release?.with?.["lease-attempt"]).toBe(
    `\${{ needs.staging-health.outputs.lease-attempt }}`,
  );
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
    source.replace(
      `lease-attempt: \${{ needs.staging-health.outputs.lease-attempt }}\n`,
      `lease-attempt: \${{ github.run_attempt }}\n`,
    ),
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
elif endpoint.endswith('/access_tokens'):
 assert json.loads(data)=={'repositories':['infra'],'permissions':{'actions':'write'}}
 print('fixture-token')
elif endpoint.endswith('/dispatches'):
 fields=dict(args[i+1].split('=',1) for i,arg in enumerate(args) if arg=='-f')
 (root/'dispatch').write_text(json.dumps(fields))
 count=int((root/'dispatch-count').read_text())+1 if (root/'dispatch-count').exists() else 1
 (root/'dispatch-count').write_text(str(count))
 if fields['inputs[action]']=='status':
  status_count=int((root/'status-count').read_text())+1 if (root/'status-count').exists() else 1
  (root/'status-count').write_text(str(status_count))
elif '/runs?' in endpoint:
 fields=json.loads((root/'dispatch').read_text())
 title='Staging power '+fields['inputs[action]']+' '+fields['inputs[lease_id]']
 run_id=776+int((root/'dispatch-count').read_text())
 matches=[{'id':run_id,'display_title':title,'created_at':'2999-01-01T00:00:00Z'},
          {'id':888,'display_title':title+'-other','created_at':'2999-01-01T00:00:00Z'}]
 if os.environ['SCENARIO']=='ambiguous': matches.append(matches[0])
 assert '--paginate' in args and '--slurp' in args
 print(json.dumps([{'workflow_runs':matches[1:]},{'workflow_runs':matches[:1]}]))
elif endpoint.endswith('/jobs?filter=latest&per_page=100'):
 scenario=os.environ['SCENARIO']
 status_count=int((root/'status-count').read_text())
 state='pending' if scenario=='timeout' or (scenario=='pending-fresh' and status_count==1) else 'fresh'
 if scenario=='failed-report':state='failed'
 steps=[{'name':'Report '+name,'conclusion':'success' if name==state else 'skipped'} for name in ['fresh','pending','failed']]
 if scenario=='missing-report':steps.pop()
 if scenario=='duplicate-report':steps.append(steps[0])
 if scenario=='none-success':
  for step in steps:step['conclusion']='skipped'
 if scenario=='multiple-success':steps[1]['conclusion']='success'
 if scenario=='failed-step':steps[2]['conclusion']='failure'
 if scenario=='unknown-report':steps[0]['name']='Report unknown'
 steps=[{'name':'Set up job','conclusion':'success'}]+steps+[{'name':'Post actions/checkout','conclusion':'success'},{'name':'Complete job','conclusion':'success'}]
 jobs=[{'name':'Pipeline staging power status','status':'completed','conclusion':'success','steps':steps}]
 if scenario=='missing-job':jobs=[]
 if scenario=='duplicate-job':jobs.append(jobs[0])
 if scenario=='late-fresh':(root/'clock').write_text(str(int((root/'clock').read_text())+2700))
 print(json.dumps([{'jobs':jobs}]))
elif '/actions/runs/' in endpoint:
 scenario=os.environ['SCENARIO']
 if scenario=='lookup-error': sys.exit(23)
 fields=json.loads((root/'dispatch').read_text())
 conclusion=scenario if scenario in ['failure','cancelled'] else 'success'
 if fields['inputs[action]']=='status' and scenario in ['status-failed','status-cancelled']:
  conclusion='failure' if scenario=='status-failed' else 'cancelled'
 print(json.dumps({'status':'completed','conclusion':conclusion}))
elif endpoint=='/installation/token': sys.exit(int(os.environ['REVOKE_EXIT_CODE']))
else: raise RuntimeError('Unexpected endpoint '+endpoint)
`;

type ScenarioOptions = {
  action: "on" | "off";
  runId?: string;
  attempt?: string;
  leaseAttempt?: string;
  scenario?: string;
  revokeExitCode?: number;
};
const FAKE_DATE = `#!/usr/bin/env bash
if [[ "$1" == +%s ]]; then
  cat "$FIXTURE_ROOT/clock"
else
  printf '2026-10-22T12:00:00Z\\n'
fi
`;
const FAKE_SLEEP = `#!/usr/bin/env bash
caller_pid=$(< "$FIXTURE_ROOT/caller-pid")
if [[ "$PPID" != "$caller_pid" ]]; then
  exec /bin/sleep "$@"
fi
elapsed="$1"
if [[ "$SCENARIO" == timeout ]]; then elapsed=2700; fi
fixture_clock=$(< "$FIXTURE_ROOT/clock")
printf '%s\\n' "$((fixture_clock + elapsed))" > "$FIXTURE_ROOT/clock"
printf '%s\\n' "$1" >> "$FIXTURE_ROOT/sleeps"
`;

const dispatch = async ({
  action,
  runId = "42",
  attempt = "1",
  leaseAttempt = attempt,
  scenario = "success",
  revokeExitCode = 0,
}: ScenarioOptions) => {
  const directory = await mkdtemp(path.join(tmpdir(), "staging-power-"));
  try {
    await Bun.write(path.join(directory, "clock"), "2000000000");
    for (const [name, body] of Object.entries({
      gh: FAKE_GH,
      date: FAKE_DATE,
      sleep: FAKE_SLEEP,
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
        REVOKE_EXIT_CODE: String(revokeExitCode),
        INFRA_REPO: "example/infra",
        POWER_ACTION: action,
        APP_CLIENT_ID: "fixture-app",
        APP_PRIVATE_KEY: "fixture-key",
        GITHUB_REPOSITORY: "example/app",
        GITHUB_RUN_ID: runId,
        GITHUB_RUN_ATTEMPT: attempt,
        LEASE_ATTEMPT: leaseAttempt,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    await Bun.write(path.join(directory, "caller-pid"), String(result.pid));
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
      sleeps: (await Bun.file(path.join(directory, "sleeps")).exists())
        ? await Bun.file(path.join(directory, "sleeps")).text()
        : "",
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test(
  "acquire and release use the same scoped lease while overlapping callers and reruns differ",
  async () => {
    const [acquired, released, overlapping, rerun] = await Promise.all([
      dispatch({ action: "on" }),
      dispatch({ action: "off" }),
      dispatch({ action: "on", runId: "43" }),
      dispatch({ action: "on", attempt: "2" }),
    ]);
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
  },
  POWER_DISPATCH_TIMEOUT_MS,
);

test(
  "a cleanup retried in a later attempt releases the lease its run acquired",
  async () => {
    const [acquired, retried] = await Promise.all([
      dispatch({ action: "on" }),
      dispatch({ action: "off", attempt: "2", leaseAttempt: "1" }),
    ]);
    expect(retried.exit).toBe(0);
    expect(retried.payload["inputs[lease_id]"]).toBe("example/app:42:1");
    expect(retried.payload["inputs[lease_id]"]).toBe(
      acquired.payload["inputs[lease_id]"],
    );
    expect(retried.payload["inputs[caller_run_attempt]"]).toBe("1");
  },
  POWER_DISPATCH_TIMEOUT_MS,
);

test(
  "the run lookup reads only runs created since its dispatch",
  async () => {
    const result = await dispatch({ action: "on" });
    const lookups = result.calls
      .split("\n")
      .filter((line) => line.includes("/runs?"));
    expect(lookups.length).toBeGreaterThan(0);
    for (const line of lookups) {
      expect(line).toMatch(
        /created=%3E%3D\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/u,
      );
    }
  },
  POWER_DISPATCH_TIMEOUT_MS,
);

test.each(["failure", "cancelled", "lookup-error", "ambiguous"])(
  "power %s cannot authorize deployment",
  async (scenario) => {
    const result = await dispatch({ action: "on", scenario });
    expect(result.exit).not.toBe(0);
    expect(result.calls).toContain('"/installation/token"');
  },
  POWER_DISPATCH_TIMEOUT_MS,
);

test.each([
  { scenario: "success", transitionStatus: 0 },
  { scenario: "failure", transitionStatus: 1 },
  { scenario: "lookup-error", transitionStatus: 23 },
])(
  "token cleanup preserves the $scenario transition status",
  async ({ scenario, transitionStatus }) => {
    const results = await Promise.all(
      [0, 37].map(async (revokeExitCode) => ({
        revokeExitCode,
        result: await dispatch({ action: "on", scenario, revokeExitCode }),
      })),
    );
    for (const { revokeExitCode, result } of results) {
      expect(result.exit).toBe(transitionStatus);
      expect(result.calls).toContain('"/installation/token"');
      if (revokeExitCode !== 0) {
        expect(result.stderr).toContain(
          "::warning::GitHub App token revocation failed.",
        );
      }
    }
  },
  POWER_DISPATCH_TIMEOUT_MS,
);

const dispatchPayloads = (calls: string) =>
  calls
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        v.parse(v.object({ args: v.array(v.string()) }), JSON.parse(line)).args,
    )
    .filter((args) => args.some((arg) => arg.endsWith("/dispatches")));

test("the readiness deadline fits inside the acquisition and health budgets", async () => {
  const workflow = v.parse(
    workflowSchema,
    Bun.YAML.parse(await Bun.file(WORKFLOW).text()),
  );
  const script = await Bun.file(path.join(ACTION_PATH, "dispatch.sh")).text();
  const seconds = Number(
    /readonly READINESS_TIMEOUT_SECONDS=(\d+)/u.exec(script)?.at(1),
  );
  expect(seconds).toBeGreaterThanOrEqual(45 * 60);
  const health = workflow.jobs["staging-health"];
  const acquire = health?.steps.find((step) => step.with?.["action"] === "on");
  const probe = health?.steps.find(
    (step) => step.name === "Probe staging health",
  );
  if (!health || !acquire?.["timeout-minutes"] || !probe?.["timeout-minutes"]) {
    throw new Error("Missing staging readiness budgets");
  }
  expect(acquire["timeout-minutes"] * 60).toBeGreaterThan(seconds);
  expect(health["timeout-minutes"]).toBeGreaterThan(
    acquire["timeout-minutes"] + probe["timeout-minutes"],
  );
});

test.each(["success", "pending-fresh"])(
  "status readiness requires fresh after %s",
  async (scenario) => {
    const result = await dispatch({
      action: "on",
      scenario,
      attempt: "2",
      leaseAttempt: "1",
    });
    expect(result.exit).toBe(0);
    const payloads = dispatchPayloads(result.calls);
    expect(
      payloads.map((args) =>
        args.find((arg) => arg.startsWith("inputs[action]=")),
      ),
    ).toEqual(
      scenario === "pending-fresh"
        ? [
            "inputs[action]=on",
            "inputs[action]=status",
            "inputs[action]=status",
          ]
        : ["inputs[action]=on", "inputs[action]=status"],
    );
    for (const args of payloads) {
      expect(args).toContain("inputs[lease_id]=example/app:42:1");
      expect(args).toContain("inputs[caller_repository]=example/app");
      expect(args).toContain("inputs[caller_run_id]=42");
      expect(args).toContain("inputs[caller_run_attempt]=1");
      expect(args).toContain("inputs[fallback_minutes]=30");
    }
    expect(result.calls).toContain("/jobs?filter=latest");
    expect(result.sleeps).toBe(scenario === "pending-fresh" ? "60\n" : "");
  },
  POWER_DISPATCH_TIMEOUT_MS,
);

test.each([
  "status-failed",
  "status-cancelled",
  "failed-report",
  "missing-report",
  "duplicate-report",
  "none-success",
  "multiple-success",
  "failed-step",
  "unknown-report",
  "missing-job",
  "duplicate-job",
  "timeout",
  "late-fresh",
])(
  "status readiness fails closed for %s",
  async (scenario) => {
    const result = await dispatch({ action: "on", scenario });
    expect(result.exit).not.toBe(0);
    expect(result.calls).toContain("inputs[action]=status");
    expect(result.calls).toContain('"/installation/token"');
    if (scenario === "timeout") {
      expect(result.stderr).toContain("readiness timed out");
      expect(dispatchPayloads(result.calls)).toHaveLength(2);
    }
  },
  POWER_DISPATCH_TIMEOUT_MS,
);

test(
  "off releases without requesting readiness",
  async () => {
    const result = await dispatch({ action: "off" });
    expect(result.exit).toBe(0);
    expect(dispatchPayloads(result.calls)).toHaveLength(1);
    expect(result.calls).not.toContain("inputs[action]=status");
  },
  POWER_DISPATCH_TIMEOUT_MS,
);
