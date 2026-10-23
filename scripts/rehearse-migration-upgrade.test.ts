import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

// Base schema, seed and the contending writer before the upgrade starts:
// measured 5 min 23 s on a hosted runner (10-19), with headroom.
const SETUP_ALLOWANCE_MINUTES = 18;
// Checkout, install and image pulls before the rehearsal step.
const JOB_SETUP_ALLOWANCE_MINUTES = 4;

const script = readFileSync(
  new URL("rehearse-migration-upgrade.sh", import.meta.url),
  "utf-8",
);
const workflow = v.parse(
  v.object({
    jobs: v.looseObject({
      "migration-upgrade-rehearsal": v.looseObject({
        "timeout-minutes": v.number(),
        steps: v.array(
          v.looseObject({
            name: v.optional(v.string()),
            "timeout-minutes": v.optional(v.number()),
          }),
        ),
      }),
    }),
  }),
  Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf-8",
    ),
  ),
);

// The script owns the rehearsal budgets; the workflow cap must never cut the
// rehearsal short inside them (it did: a 9 min step against a 900 s budget).
test("the rehearsal step and job timeouts derive from the script's own budget", () => {
  const budgetSeconds = Number(
    /^budget="\$\{REHEARSAL_MIGRATE_BUDGET_SECONDS:-(\d+)\}"$/mu.exec(
      script,
    )?.[1],
  );
  expect(Number.isInteger(budgetSeconds) && budgetSeconds > 0).toBe(true);
  // The upgrade and its fixed-point rerun each run under the budget.
  expect(script.match(/timeout --foreground "\$budget"/gu)).toHaveLength(2);

  const job = workflow.jobs["migration-upgrade-rehearsal"];
  const step = job.steps.find(
    ({ name }) =>
      name === "Rehearse the upgrade from the promoted release at scale",
  );
  const stepMinutes =
    SETUP_ALLOWANCE_MINUTES + Math.ceil((2 * budgetSeconds) / 60);
  expect(step?.["timeout-minutes"]).toBe(stepMinutes);
  expect(job["timeout-minutes"]).toBe(
    stepMinutes + JOB_SETUP_ALLOWANCE_MINUTES,
  );
});

test("the rehearsal boots both releases and enforces online repair coverage", () => {
  expect(script).toContain(
    'boot_until_ready "$base_image" stella-rehearsal-base-api',
  );
  expect(script).toContain(
    'boot_until_ready "$checkout_image" stella-rehearsal-checkout-api',
  );
  expect(script).toContain("assert-online-migration-rehearsal.ts");
  expect(script).toContain('--rehearsal-online-repair-report "$repair_report"');
});

// A fake docker that behaves like the real one where it matters: a container
// started with --rm is gone once it exits, and so are its logs.
const FAKE_DOCKER = `#!/usr/bin/env bash
state="$FAKE_DOCKER_STATE"
name=""
for arg in "$@"; do [[ -n "$prev" && "$prev" == "--name" ]] && name="$arg"; prev="$arg"; done
case "$1" in
  run)
    [[ " $* " == *" --rm "* ]] && touch "$state/removes-on-exit"
    touch "$state/$name" ;;
  inspect)
    target="\${@: -1}"
    [[ -f "$state/removes-on-exit" ]] && rm -f "$state/$target"
    [[ -f "$state/$target" ]] || { echo "No such object: $target" >&2; exit 1; }
    echo false ;;
  logs)
    target="\${@: -1}"
    [[ -f "$state/$target" ]] || { echo "No such container: $target" >&2; exit 1; }
    echo "fatal: startup refused by the database" ;;
  rm)
    rm -f "$state/\${@: -1}" ;;
  stop) ;;
esac
`;

test("an API that exits before /ready prints its startup logs, fails and is removed", async () => {
  const boot = /^boot_until_ready\(\) \{\n[\s\S]*?\n\}\n/mu.exec(script)?.[0];
  expect(boot).toBeDefined();
  const directory = await mkdtemp(path.join(tmpdir(), "rehearsal-boot-"));
  try {
    const bin = path.join(directory, "bin");
    const state = path.join(directory, "state");
    await mkdir(bin);
    await mkdir(state);
    for (const [name, body] of Object.entries({
      docker: FAKE_DOCKER,
      curl: "#!/usr/bin/env bash\nexit 7\n",
    })) {
      await Bun.write(path.join(bin, name), body);
      await chmod(path.join(bin, name), 0o700);
    }
    const result = Bun.spawnSync(
      [
        "bash",
        "-c",
        `fail() { echo "FAIL: $*"; exit 1; }\napi_env=()\n${boot}\nboot_until_ready example/api:base stella-rehearsal-base-api`,
      ],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env["PATH"] ?? ""}`,
          FAKE_DOCKER_STATE: state,
        },
      },
    );
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    expect(result.exitCode).toBe(1);
    expect(output).toContain("fatal: startup refused by the database");
    expect(output).toContain("exited before /ready answered");
    expect(await readdir(state)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
