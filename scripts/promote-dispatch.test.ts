import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";

const ACTION = path.resolve(
  import.meta.dir,
  "../.github/actions/promote-dispatch/action.yml",
);
const HELPER = path.resolve(import.meta.dir, "gh-retry.sh");
const FAKE_GH = `#!/usr/bin/env python3
import json,os,pathlib,subprocess,sys
root=pathlib.Path(os.environ['FAKE_ROOT'])
args=sys.argv[1:]
if args[:2]==['run','download']:
 with (root/'calls').open('a') as calls:calls.write('artifact '+args[2]+' '+args[args.index('--repo')+1]+'\\n')
 if os.environ.get('RECEIPT')!='available':sys.exit(1)
 directory=pathlib.Path(args[args.index('--dir')+1])
 (directory/'receipt.json').write_text('{"commit":"fixture"}')
 sys.exit(0)
sys.stdin.buffer.read()
endpoint=next((arg for arg in args if arg.startswith('/')), '')
method=args[args.index('--method')+1] if '--method' in args else 'GET'
if endpoint.endswith('/access_tokens'):phase='token'
elif endpoint.endswith('/dispatches'):phase='dispatch'
elif '/runs?' in endpoint:phase='lookup' if (root/'dispatch-count').exists() else 'existing'
elif endpoint.endswith('/runs/777'):phase='poll'
elif endpoint=='/installation/token':phase='revoke'
elif endpoint.endswith('/installation'):phase='installation'
else:raise RuntimeError('unexpected fixture endpoint')
count=root/(phase+'-count')
attempt=int(count.read_text())+1 if count.exists() else 1
count.write_text(str(attempt))
failing=phase==os.environ['FAILURE_PHASE'] and attempt==1
with (root/'calls').open('a') as calls:calls.write(phase+' '+method+' '+str(attempt)+' '+('failed' if failing else 'ok')+'\\n')
if failing:
 sys.stdout.write('partial-response-do-not-publish')
 if os.environ['FAILURE_KIND']=='transport':sys.stderr.write('Get "https://api.github.com/example?token=private-token-do-not-print": EOF\\n')
 else:sys.stderr.write('gh: invalid query selection private-token-do-not-print\\n')
 sys.exit(23)
if phase=='installation':payload={'id':123}
elif phase=='token':payload={'token':'fixture-token'}
elif phase=='existing':
 matching=[] if os.environ['PRIOR_RUN']=='none' else [{'id':777,'display_title':'Promote v1.2.3 → '+os.environ['TARGET_ENV'],'status':('in_progress' if os.environ['PRIOR_RUN']=='active' else 'completed'),'conclusion':('success' if os.environ['PRIOR_RUN']=='success' else 'failure' if os.environ['PRIOR_RUN']=='failed' else None)}]
 pages=[{'workflow_runs':matching}]
 if os.environ['PRIOR_RUN_PAGE']=='2':
  pages=[{'workflow_runs':[{'id':1000+i,'display_title':'Promote v9.9.'+str(i)+' → staging','status':'completed','conclusion':'success'} for i in range(100)]},{'workflow_runs':matching}]
 if '--paginate' not in args:pages=pages[:1]
 if '--slurp' in args:payload=pages
 else:payload=pages[0]
elif phase=='lookup':payload={'workflow_runs':[
 {'id':444,'created_at':'2026-01-01T00:00:00Z','display_title':'Promote v1.2.3 → '+os.environ['TARGET_ENV']},
 {'id':555,'created_at':'2026-10-07T12:00:01Z','display_title':'Promote v1.2.3-rc.1 → '+os.environ['TARGET_ENV']},
 {'id':777,'created_at':'2026-10-07T12:00:01Z','display_title':'Promote v1.2.3 → '+os.environ['TARGET_ENV']}]}
elif phase=='poll':
 completed=attempt>= (3 if os.environ['FAILURE_PHASE']=='poll' else 2)
 payload={'status':'completed' if completed else 'in_progress','conclusion':'success' if completed else None,'html_url':'https://github.com/example/infra/actions/runs/777'}
else:sys.exit(0)
if '--jq' in args:
 result=subprocess.run(['jq','-r',args[args.index('--jq')+1]],input=json.dumps(payload),text=True,capture_output=True)
 sys.stdout.write(result.stdout);sys.stderr.write(result.stderr);sys.exit(result.returncode)
sys.stdout.write(json.dumps(payload)+'\\n')
`;
const FAKE_OPENSSL = `#!/usr/bin/env python3
import base64,sys
if sys.argv[1]=='base64':sys.stdout.write(base64.b64encode(sys.stdin.buffer.read()).decode())
else:sys.stdout.write('fixture-signature')
`;
const FAKE_DATE = `#!/usr/bin/env python3
import sys
print('1000' if '+%s' in sys.argv else '2026-10-07T12:00:00Z')
`;
const FAKE_SLEEP = `#!/usr/bin/env python3
import os,pathlib,select,sys
if int(sys.argv[1])>=50:
 parent=os.getppid()
 while os.getppid()==parent:select.select([],[],[],0.01)
else:
 with (pathlib.Path(os.environ['FAKE_ROOT'])/'sleeps').open('a') as sleeps:sleeps.write(sys.argv[1]+'\\n')
`;

type PromotionScenarioOptions = {
  failurePhase: "lookup" | "poll" | "none";
  failureKind: "transport" | "unknown";
  receipt?: "available" | "missing";
  targetEnvironment: "production" | "staging";
  priorRun?: "none" | "success" | "active" | "failed";
  priorRunPage?: 1 | 2;
  expectedSha?: string;
  deployedSha?: string;
};
const promotionScenario = async ({
  failurePhase,
  failureKind,
  receipt,
  targetEnvironment,
  priorRun = "none",
  priorRunPage = 1,
  expectedSha = "",
  deployedSha = "a".repeat(40),
}: PromotionScenarioOptions) => {
  const action = v.parse(
    v.object({
      runs: v.object({ steps: v.tuple([v.object({ run: v.string() })]) }),
    }),
    Bun.YAML.parse(await readFile(ACTION, "utf-8")),
  );
  const directory = await mkdtemp(
    path.resolve(import.meta.dir, "../.promote-dispatch-test-"),
  );
  try {
    const scripts = path.join(directory, "scripts");
    const actionPath = path.join(directory, ".github/actions/promote-dispatch");
    await Promise.all([mkdir(scripts), mkdir(actionPath, { recursive: true })]);
    await writeFile(path.join(scripts, "gh-retry.sh"), await readFile(HELPER));
    await Promise.all([
      writeFile(path.join(directory, "gh"), FAKE_GH, { mode: 0o700 }),
      writeFile(path.join(directory, "openssl"), FAKE_OPENSSL, { mode: 0o700 }),
      writeFile(path.join(directory, "date"), FAKE_DATE, { mode: 0o700 }),
      writeFile(path.join(directory, "sleep"), FAKE_SLEEP, { mode: 0o700 }),
      writeFile(
        path.join(directory, "curl"),
        `#!/bin/sh\nprintf '{"status":"ok","commit":"${deployedSha}"}\\n'\n`,
        { mode: 0o700 },
      ),
    ]);
    const process = Bun.spawn(["bash", "-c", action.runs.steps[0].run], {
      cwd: directory,
      env: {
        ...Bun.env,
        PATH: `${directory}:${Bun.env["PATH"] ?? ""}`,
        FAKE_ROOT: directory,
        FAILURE_PHASE: failurePhase,
        PRIOR_RUN: priorRun,
        PRIOR_RUN_PAGE: String(priorRunPage),
        EXPECTED_SHA: expectedSha,
        FAILURE_KIND: failureKind,
        GITHUB_ACTION_PATH: actionPath,
        APP_CLIENT_ID: "fixture-app",
        APP_PRIVATE_KEY: "fixture-key",
        INFRA_REPO: "example/infra",
        WORKFLOW_FILE: "promote-release.yml",
        RELEASE_REF: "v1.2.3",
        TARGET_ENV: targetEnvironment,
        RUN_MIGRATIONS: "true",
        FRONTEND: "false",
        IMAGE_DIGEST: "",
        WEB_IMAGE_DIGEST: "",
        GIT_SHA: "",
        STAGING_PROOF_STATE_PATH:
          receipt === undefined ? "" : path.join(directory, "proof-state"),
        RECEIPT: receipt ?? "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    const calls = (await readFile(path.join(directory, "calls"), "utf-8"))
      .trim()
      .split("\n");
    expect(stdout + stderr).not.toContain("private-token-do-not-print");
    expect(stdout + stderr).not.toContain("partial-response-do-not-publish");
    expect(calls.filter((call) => call.startsWith("token "))).toEqual([
      "token POST 1 ok",
    ]);
    expect(calls.filter((call) => call.startsWith("dispatch "))).toEqual(
      targetEnvironment === "production" &&
        (priorRun === "success" ||
          priorRun === "active" ||
          (priorRun === "none" &&
            expectedSha !== "" &&
            expectedSha === deployedSha))
        ? []
        : ["dispatch POST 1 ok"],
    );
    const receiptFile = Bun.file(path.join(directory, "proof-state.ecs.json"));
    const recordedReceipt = (await receiptFile.exists())
      ? await receiptFile.text()
      : undefined;
    return { exit, stdout, stderr, calls, recordedReceipt };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("promotion watches the exact dispatched run through completion", async () => {
  const result = await promotionScenario({
    failurePhase: "none",
    failureKind: "unknown",
    targetEnvironment: "staging",
  });
  expect(result.exit).toBe(0);
  expect(result.stdout).toContain("Found dispatched run: 777");
  expect(result.stdout).toContain(
    "Promote run completed successfully: https://github.com/example/infra/actions/runs/777",
  );
  expect(result.calls.filter((call) => call.startsWith("poll "))).toEqual([
    "poll GET 1 ok",
    "poll GET 2 ok",
  ]);
});

test.each(["lookup", "poll"] as const)(
  "promotion recovers one %s transport failure without repeating writes",
  async (failurePhase) => {
    const result = await promotionScenario({
      failurePhase,
      failureKind: "transport",
      targetEnvironment: "staging",
    });
    expect(result.calls).toContain(`${failurePhase} GET 1 failed`);
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain(
      "Promote run completed successfully: https://github.com/example/infra/actions/runs/777",
    );
    expect(
      result.calls.filter((call) => call.startsWith(`${failurePhase} `)),
    ).toEqual(
      failurePhase === "lookup"
        ? ["lookup GET 1 failed", "lookup GET 2 ok"]
        : ["poll GET 1 failed", "poll GET 2 ok", "poll GET 3 ok"],
    );
  },
);

test.each(["lookup", "poll"] as const)(
  "promotion fails immediately on an unknown %s error",
  async (failurePhase) => {
    const result = await promotionScenario({
      failurePhase,
      failureKind: "unknown",
      targetEnvironment: "staging",
    });
    expect(result.exit).toBe(1);
    expect(
      result.calls.filter((call) => call.startsWith(`${failurePhase} `)),
    ).toEqual([`${failurePhase} GET 1 failed`]);
    expect(result.stderr).toContain(
      failurePhase === "lookup"
        ? "Dispatched run lookup failed."
        : "Promote run status lookup failed.",
    );
    expect(result.stdout).not.toContain("Promote run completed successfully:");
  },
);

test("proof consumes the ECS receipt from the exact dispatched run", async () => {
  const result = await promotionScenario({
    failurePhase: "none",
    failureKind: "unknown",
    targetEnvironment: "staging",
    receipt: "available",
  });
  expect(result.exit).toBe(0);
  expect(result.calls).toContain("artifact 777 example/infra");
  expect(result.recordedReceipt).toBe('{"commit":"fixture"}');
});

test("a missing ECS receipt remains absent for the proof readiness gate", async () => {
  const result = await promotionScenario({
    failurePhase: "none",
    failureKind: "unknown",
    targetEnvironment: "staging",
    receipt: "missing",
  });
  expect(result.exit).toBe(0);
  expect(result.recordedReceipt).toBeUndefined();
  expect(result.stdout).toContain(
    "::warning::Deployment ECS readiness receipt is unavailable.",
  );
});

for (const priorRun of ["success", "active", "failed"] as const) {
  test(`production retries ${priorRun} receipts only when they can still succeed`, async () => {
    const result = await promotionScenario({
      failurePhase: "none",
      failureKind: "unknown",
      targetEnvironment: "production",
      priorRun,
    });
    expect(result.exit).toBe(0);
    expect(
      result.calls.filter((call) => call.startsWith("dispatch POST")),
    ).toHaveLength(priorRun === "failed" ? 1 : 0);
  });
}

test("production already serving the exact API and web SHA never dispatches again", async () => {
  const result = await promotionScenario({
    failurePhase: "none",
    failureKind: "unknown",
    targetEnvironment: "production",
    expectedSha: "a".repeat(40),
    deployedSha: "a".repeat(40),
  });
  expect(result.exit).toBe(0);
  expect(
    result.calls.filter((call) => call.startsWith("dispatch POST")),
  ).toHaveLength(0);
});

test("an active promotion is watched to completion even when production already serves the SHA", async () => {
  const result = await promotionScenario({
    failurePhase: "none",
    failureKind: "unknown",
    targetEnvironment: "production",
    priorRun: "active",
    expectedSha: "a".repeat(40),
    deployedSha: "a".repeat(40),
  });
  expect(result.exit, result.stderr).toBe(0);
  expect(result.stdout + result.stderr).not.toContain(
    "Production already serves",
  );
  expect(result.calls.some((call) => call.startsWith("poll "))).toBe(true);
});

// A failed run may have stopped after the rollout, so the served commit
// alone cannot stand in for its unfinished infrastructure work.
test("a failed promotion is dispatched again even when production already serves the SHA", async () => {
  const result = await promotionScenario({
    failurePhase: "none",
    failureKind: "unknown",
    targetEnvironment: "production",
    priorRun: "failed",
    expectedSha: "a".repeat(40),
    deployedSha: "a".repeat(40),
  });
  expect(result.exit, result.stderr).toBe(0);
  expect(result.stdout + result.stderr).not.toContain(
    "Production already serves",
  );
  expect(
    result.calls.filter((call) => call.startsWith("dispatch POST")),
  ).toHaveLength(1);
});

test("a successful promotion on the second page prevents another dispatch", async () => {
  const result = await promotionScenario({
    failurePhase: "none",
    failureKind: "unknown",
    targetEnvironment: "production",
    priorRun: "success",
    priorRunPage: 2,
  });
  expect(result.exit).toBe(0);
  expect(result.stdout).toContain("Promotion already succeeded: 777");
  expect(
    result.calls.filter((call) => call.startsWith("dispatch POST")),
  ).toHaveLength(0);
  expect(result.calls.filter((call) => call.startsWith("poll "))).toHaveLength(
    0,
  );
});

for (const priorRun of ["success", "active"] as const) {
  test(`staging dispatches again after an old ${priorRun} receipt when a different SHA is deployed`, async () => {
    const expectedSha = "a".repeat(40);
    const deployedSha = "b".repeat(40);
    expect(deployedSha).not.toBe(expectedSha);
    const result = await promotionScenario({
      failurePhase: "none",
      failureKind: "unknown",
      targetEnvironment: "staging",
      priorRun,
      expectedSha,
      deployedSha,
    });
    expect(result.exit).toBe(0);
    expect(
      result.calls.filter((call) => call.startsWith("dispatch POST")),
    ).toEqual(["dispatch POST 1 ok"]);
    expect(
      result.calls.filter((call) => call.startsWith("existing ")),
    ).toHaveLength(0);
    expect(result.stdout).toContain("Found dispatched run: 777");
  });
}
