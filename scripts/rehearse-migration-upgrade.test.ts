import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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

test("real readiness retains service, image and credential ownership", () => {
  expect(script).toContain('--compose "$repo_root/docker-compose.yml"');
  expect(script).toContain("pull rustfs gotenberg rustfs-setup");
  expect(script).toContain("--wait-timeout 60 rustfs gotenberg");
  expect(script).toContain("run --rm --no-deps rustfs-setup");
  expect(script).toContain("services.rustfs.environment.RUSTFS_ACCESS_KEY");
  expect(script).toContain("services.rustfs.environment.RUSTFS_SECRET_KEY");
  expect(script).toContain("S3_CREDENTIALS_PROVIDER=env");
  expect(script).toContain("GOTENBERG_URL=http://127.0.0.1:3003");
  expect(script).not.toContain("SCHEDULED_JOBS_MODE=disabled");
  expect(script).toContain('--pull "$repo_root/apps/api/Dockerfile"');
  expect(script).toContain('--build "$repo_root/apps/api/Dockerfile"');
  expect(script).not.toContain("docker build ");
  expect(script).toContain('--rehearsal-online-repair-report "$repair_report"');
  expect(script).toContain('repair_report="$runtime_dir/repairs.jsonl"');
  const setupSeconds =
    8 * 60 +
    Number(
      /--kill-after=5 (\d+) bash -c.*prepare_dependencies/u.exec(script)?.[1],
    ) +
    2 * Number(/--kill-after=5 (\d+) bash -c.*boot_api/u.exec(script)?.[1]);
  expect(setupSeconds / 60).toBe(SETUP_ALLOWANCE_MINUTES);
  const names = workflow.jobs["migration-upgrade-rehearsal"].steps.map(
    ({ name }) => name,
  );
  expect(names.indexOf("Drop the registry credential")).toBeLessThan(
    names.indexOf("Rehearse the upgrade from the promoted release at scale"),
  );
  expect(names.indexOf("Remove workflow tooling")).toBeGreaterThan(
    names.indexOf("Rehearse the upgrade from the promoted release at scale"),
  );
});

// These processes certify orchestration, not actual Docker or dependency health.
const fakeDocker = `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const state = process.env.REHEARSAL_TEST_STATE;
appendFileSync(path.join(state, "events"), "docker " + args.join(" ") + "\\n");
const nameIndex = args.indexOf("--name");
const name = nameIndex >= 0 ? args[nameIndex + 1] : args.at(-1);
const container = path.join(state, name ?? "none");
if (args[0] === "compose") {
  if (args.includes("config")) console.log(JSON.stringify({services:{rustfs:{environment:{RUSTFS_ACCESS_KEY:"test-access",RUSTFS_SECRET_KEY:"test-secret"}}}}));
  if (args.includes("up") && process.env.REHEARSAL_TEST_FAILURE === "dependency") process.exit(19);
} else if (args[0] === "run" && nameIndex >= 0) {
  writeFileSync(container, "running");
} else if (args[0] === "inspect") {
  console.log(process.env.REHEARSAL_TEST_FAILURE === "exited" || existsSync(path.join(state,"exited-after-ready")) ? "false" : existsSync(container) ? "true" : "false");
} else if (args[0] === "logs") {
  console.log(process.env.REHEARSAL_TEST_FAILURE === "exited" ? "fatal: startup refused by the database" : process.env.REHEARSAL_TEST_FAILURE === "scheduler" ? "server listening" : JSON.stringify({message:"scheduler.started"}));
} else if (args[0] === "rm") {
  rmSync(container, {force:true});
}
`;

const fakeBun = `#!${process.execPath}
import { appendFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
appendFileSync(path.join(process.env.REHEARSAL_TEST_STATE, "events"), "bun " + args.join(" ") + "\\n");
if (args.includes("assert-empty") && process.env.REHEARSAL_TEST_FAILURE === "nonempty") {
  process.exit(29);
} else if (args.includes("contend")) {
  console.log("contending: locks held");
  setInterval(() => {}, 1000);
} else if (args.includes("--compose")) {
  console.log("{}");
} else if (args.includes("--build") && process.env.REHEARSAL_TEST_FAILURE === "build") {
  process.exit(23);
} else if (args[0] === "-e") {
  if (args[1].includes("Date.now")) console.log(Date.now());
  else if (args[1].includes("RUSTFS_ACCESS_KEY")) process.stdout.write("test-access");
  else if (args[1].includes("RUSTFS_SECRET_KEY")) process.stdout.write("test-secret");
} else if (args.includes("--bun")) {
  console.log("No changes detected");
} else if (args[0]?.endsWith("migration-rehearsal-writer-gap.ts")) {
  console.log("0s");
} else if (args.includes("digest")) {
  console.log("unchanged");
}
`;

const fakeTimeout = `#!${process.execPath}
import { appendFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
appendFileSync(path.join(process.env.REHEARSAL_TEST_STATE, "events"), "timeout " + args.slice(0,3).join(" ") + "\\n");
if (args[0] !== "--foreground") process.exit(91);
let index = 1;
if (args[index].startsWith("--kill-after=")) index++;
const seconds = args[index++];
const child = Bun.spawn(args.slice(index), {stdin:"inherit", stdout:"inherit", stderr:"inherit"});
// Shorten only the boot bound in this fake; the production script owns 120s.
let expired = false;
const timer = seconds === "120" && ["deadline", "scheduler"].includes(process.env.REHEARSAL_TEST_FAILURE)
  ? setTimeout(() => { expired = true; child.kill("SIGTERM"); }, 250)
  : undefined;
const status = await child.exited;
clearTimeout(timer);
process.exit(expired ? 124 : status);
`;

const runFake = async (failure: string, body = script) => {
  const directory = await mkdtemp(path.join(tmpdir(), "rehearsal-readiness-"));
  const bin = path.join(directory, "bin");
  const state = path.join(directory, "state");
  const runtime = path.join(directory, "runtime");
  await Promise.all([mkdir(bin), mkdir(state), mkdir(runtime)]);
  try {
    for (const [name, source] of Object.entries({
      docker: fakeDocker,
      bun: fakeBun,
      timeout: fakeTimeout,
      curl: `#!/usr/bin/env bash\nprintf 'curl\\n' >> "$REHEARSAL_TEST_STATE/events"\n[[ "$REHEARSAL_TEST_FAILURE" != after-ready ]] || touch "$REHEARSAL_TEST_STATE/exited-after-ready"\n[[ "$REHEARSAL_TEST_FAILURE" != deadline ]]\n`,
    })) {
      await Bun.write(path.join(bin, name), source);
      await chmod(path.join(bin, name), 0o700);
    }
    // Keep BASH_SOURCE resolution rooted at the actual repository, even when
    // testing an extracted function; no application or Docker code is run.
    const result = Bun.spawn(
      [
        "bash",
        "-c",
        body.replace(
          `repo_root="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"`,
          () => 'repo_root="$FAKE_REPOSITORY"',
        ),
      ],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env["PATH"] ?? ""}`,
          TMPDIR: runtime,
          REHEARSAL_TEST_STATE: state,
          REHEARSAL_TEST_FAILURE: failure,
          FAKE_REPOSITORY: path.resolve(import.meta.dir, ".."),
          DATABASE_URL: "postgres://disposable/test",
          REHEARSAL_BASE_REF: "v1.2.3",
          REHEARSAL_CI_TOOLING: path.resolve(import.meta.dir, ".."),
          GITHUB_STEP_SUMMARY: path.join(directory, "summary.md"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      result.exited,
      new Response(result.stdout).text(),
      new Response(result.stderr).text(),
    ]);
    return {
      exitCode,
      output: stdout + stderr,
      events: await readFile(path.join(state, "events"), "utf-8"),
      state: (await readdir(state)).filter(
        (name) => !["events", "exited-after-ready"].includes(name),
      ),
      runtime: await readdir(runtime),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("base startup precedes target fixtures and candidate startup follows all migration proofs", async () => {
  const result = await runFake("");
  expect(result.exitCode, result.output).toBe(0);
  const events = result.events.split("\n");
  const baseBoot = events.findIndex(
    (event) => event.startsWith("docker run -d") && event.includes("-base "),
  );
  const candidateBoot = events.findIndex(
    (event) =>
      event.startsWith("docker run -d") && event.includes("-candidate "),
  );
  const seed = events.findIndex((event) =>
    event.includes("seed-migration-rehearsal.ts"),
  );
  const parity = events.findIndex((event) =>
    event.includes("drizzle-kit push"),
  );
  expect(baseBoot).toBeGreaterThan(-1);
  expect(seed).toBeGreaterThan(baseBoot);
  expect(parity).toBeGreaterThan(seed);
  expect(candidateBoot).toBeGreaterThan(parity);
  const version = readFileSync(
    new URL("../VERSION", import.meta.url),
    "utf-8",
  ).trim();
  expect(result.events).toContain(`--build-arg STELLA_VERSION=${version}`);
  expect(result.events).toContain("--volumes --remove-orphans");
  expect(result.state).toEqual([]);
  expect(result.runtime).toEqual([]);
});

test("a nonempty database is rejected before Docker work or resource allocation", async () => {
  const result = await runFake("nonempty");
  expect(result.exitCode).toBe(29);
  expect(result.events).toContain(" assert-empty");
  expect(result.events).not.toContain("docker ");
  expect(result.events).not.toContain("--compose");
  expect(result.runtime).toEqual([]);
  expect(result.state).toEqual([]);
});

test("preparation failures preserve status and clean resources before any contender exists", async () => {
  for (const failure of ["dependency", "build"]) {
    const result = await runFake(failure);
    expect(result.exitCode).toBe(failure === "dependency" ? 19 : 23);
    expect(result.events).not.toContain(" contend");
    expect(result.events).toContain("--volumes --remove-orphans");
    expect(result.events).toContain(
      "docker image rm stella-api-migration-rehearsal:",
    );
    expect(result.state).toEqual([]);
    expect(result.runtime).toEqual([]);
  }
});

test("dead API containers retain startup diagnostics and cannot borrow a healthy listener", async () => {
  const result = await runFake("exited");
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain("fatal: startup refused by the database");
  expect(result.output).toContain("within 120s");
  expect(result.events).not.toContain("curl\n");
  expect(result.state).toEqual([]);
  expect(result.runtime).toEqual([]);
});

test("a process that exits during a successful ready request is rejected", async () => {
  const result = await runFake("after-ready");
  expect(result.exitCode).toBe(1);
  expect(result.events).toContain("curl\n");
  expect(result.events).not.toContain("seed-migration-rehearsal.ts");
  expect(result.state).toEqual([]);
  expect(result.runtime).toEqual([]);
});

test.each(["scheduler", "deadline"])(
  "readiness enforces its owned process and boot deadline: %s",
  async (failure) => {
    const result = await runFake(failure);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("within 120s");
    expect(result.events).toContain("timeout --foreground --kill-after=5 120");
    expect(result.events).toContain("docker logs");
    if (failure === "scheduler") {
      expect(result.events).not.toContain("curl\n");
    } else {
      expect(result.events).toContain("curl\n");
    }
    expect(result.state).toEqual([]);
    expect(result.runtime).toEqual([]);
  },
);
