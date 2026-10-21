import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

type ScenarioOptions = {
  mode: "head" | "runner" | "ready";
  scenario:
    | "head-later"
    | "head-never"
    | "online"
    | "offline"
    | "unconfigured"
    | "appears"
    | "disappears"
    | "ready-later"
    | "ready-never";
};
const scenario = async ({
  mode,
  scenario: fixtureScenario,
}: ScenarioOptions) => {
  const directory = await mkdtemp(path.join(tmpdir(), "release-stage-"));
  try {
    await writeFile(path.join(directory, "count"), "0");
    const helper = path.join(directory, "gh-retry.sh");
    await writeFile(
      helper,
      `#!/usr/bin/env bash
set -eu
counter="$FAKE_ROOT/count"
count=0
if [[ -f "$counter" ]]; then count=$(cat "$counter"); fi
count=$((count+1)); echo "$count" > "$counter"
case "$SCENARIO" in
ready-later) if ((count>=3)); then echo '{"status":"ok"}'; else echo '{"status":"not_ready"}'; fi ;;
ready-never) echo '{"status":"not_ready"}' ;;
head-later) if ((count>=3)); then echo base; else echo other; fi ;;
head-never) echo other ;;
online) echo '{"runners":[{"id":1,"status":"online","labels":[{"name":"deploy-test"}]}]}' ;;
offline) echo '{"runners":[{"id":1,"status":"offline","labels":[{"name":"deploy-test"}]}]}' ;;
disappears) if ((count>=2)); then echo '{"runners":[{"id":1,"status":"offline","labels":[{"name":"deploy-test"}]}]}'; else echo '{"runners":[{"id":1,"status":"offline","labels":[{"name":"deploy-test"}]},{"id":2,"status":"offline","labels":[{"name":"deploy-test"}]}]}'; fi ;;
appears) if ((count>=2)); then echo '{"runners":[{"id":2,"status":"offline","labels":[{"name":"deploy-test"}]}]}'; else echo '{"runners":[]}'; fi ;;
esac
`,
    );
    const sleep = path.join(directory, "sleep");
    await writeFile(sleep, "#!/usr/bin/env bash\nexit 0\n");
    await chmod(sleep, 0o700);
    const curl = path.join(directory, "curl");
    await writeFile(
      curl,
      '#!/usr/bin/env bash\nexec bash "$GH_RETRY_SCRIPT"\n',
    );
    await chmod(curl, 0o700);
    const process = Bun.spawn(
      ["bash", path.join(import.meta.dir, "release-stage-preflight.sh"), mode],
      {
        env: {
          ...Bun.env,
          PATH: `${directory}:${Bun.env["PATH"] ?? ""}`,
          GH_RETRY_SCRIPT: helper,
          FAKE_ROOT: directory,
          SCENARIO: fixtureScenario,
          REQUIRED_DEPLOY_RUNNER_LABEL:
            fixtureScenario === "unconfigured" ? "" : "deploy-test",
          EXPECTED_BASE: "base",
          GITHUB_REPOSITORY: "example/repo",
          GITHUB_REPOSITORY_OWNER: "example",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exit, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);
    return {
      exit,
      stderr,
      reads: Number(await readFile(path.join(directory, "count"), "utf-8")),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("waits for preceding entries to merge before staging", async () => {
  expect(await scenario({ mode: "head", scenario: "head-later" })).toEqual({
    exit: 0,
    stderr: "",
    reads: 3,
  });
});
test("refuses a group that never reaches main within the bounded wait", async () => {
  const result = await scenario({ mode: "head", scenario: "head-never" });
  expect(result.exit).toBe(1);
  expect(result.reads).toBe(121);
  expect(result.stderr).toContain(
    "group_head_timeout: group did not become the head group in 60 min",
  );
});
test.each(["online", "appears"] as const)(
  "accepts %s ephemeral runner availability",
  async (availability) => {
    expect(
      (await scenario({ mode: "runner", scenario: availability })).exit,
    ).toBe(0);
  },
);
test("an existing offline runner is not evidence of recent online availability", async () => {
  const result = await scenario({ mode: "runner", scenario: "offline" });
  expect(result.exit).toBe(1);
  expect(result.reads).toBe(3);
  expect(result.stderr).toContain("required_runner_offline");
});

test("removing a stale registration does not count as a runner appearing", async () => {
  const result = await scenario({ mode: "runner", scenario: "disappears" });
  expect(result.exit).toBe(1);
  expect(result.reads).toBe(3);
  expect(result.stderr).toContain("required_runner_offline");
});

test("power-on readiness waits through database startup", async () => {
  const result = await scenario({ mode: "ready", scenario: "ready-later" });
  expect(result.exit).toBe(0);
  expect(result.reads).toBe(3);
});
test("power-on readiness has a finite refusal budget", async () => {
  const result = await scenario({ mode: "ready", scenario: "ready-never" });
  expect(result.exit).toBe(1);
  expect(result.reads).toBe(20);
  expect(result.stderr).toContain("staging_power_readiness_timeout");
});

test("missing deployment runner configuration refuses before reading the inventory", async () => {
  const result = await scenario({ mode: "runner", scenario: "unconfigured" });
  expect(result.exit).toBe(1);
  expect(result.reads).toBe(0);
  expect(result.stderr).toContain("runner_label_unconfigured");
});
