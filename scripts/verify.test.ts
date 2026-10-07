import { expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseVerifyArgs, runAutofixSteps, runVerifySteps } from "./verify";
import {
  admitLocal,
  BOTH_GATES_MESSAGE,
  BOTH_GATES_REFUSED,
  withCheckAdmission,
} from "./verify-admission";
import { VerifyError } from "./verify-error";
import { readVerifyWorkflow, type VerifyWorkflowStep } from "./verify-workflow";

const root = path.resolve(import.meta.dirname, "..");

test.each([0, 1, 2, 64, 127])(
  "local acceptance propagates status %i without remote execution",
  (status) => {
    const events: string[] = [];
    expect(
      withCheckAdmission({
        alreadyRemote: false,
        admitLocal: () => 0,
        probeRemote: () => {
          events.push("probe");
          return 0;
        },
        runLocal: () => {
          events.push("local");
          return status;
        },
        runRemote: () => {
          events.push("remote");
          return 0;
        },
        report: (message) => events.push(message),
      }),
    ).toBe(status);
    expect(events).toEqual(["local"]);
  },
);
test.each([0, 1, 2, 75])(
  "remote acceptance propagates status %i without local execution",
  (status) => {
    const events: string[] = [];
    expect(
      withCheckAdmission({
        alreadyRemote: false,
        admitLocal: () => BOTH_GATES_REFUSED,
        probeRemote: () => {
          events.push("probe");
          return 0;
        },
        runLocal: () => {
          events.push("local");
          return 0;
        },
        runRemote: () => {
          events.push("remote");
          return status;
        },
        report: (message) => events.push(message),
      }),
    ).toBe(status);
    expect(events).toEqual([
      "probe",
      "remote",
      ...(status === 75 ? [BOTH_GATES_MESSAGE] : []),
    ]);
  },
);
test.each([1, 2, 64, 75, 127, 255])(
  "probe status %i distinguishes refusal from errors",
  (status) => {
    const events: string[] = [];
    expect(
      withCheckAdmission({
        alreadyRemote: false,
        admitLocal: () => BOTH_GATES_REFUSED,
        probeRemote: () => status,
        runLocal: () => {
          events.push("local");
          return 0;
        },
        runRemote: () => {
          events.push("remote");
          return 0;
        },
        report: (message) => events.push(message),
      }),
    ).toBe(status);
    expect(events).toEqual(
      status === BOTH_GATES_REFUSED ? [BOTH_GATES_MESSAGE] : [],
    );
  },
);
test.each([1, 2, 64, 127])(
  "admission error %i aborts without a fallback",
  (status) => {
    const unexpected = () => {
      throw new TypeError("unexpected execution");
    };
    expect(
      withCheckAdmission({
        alreadyRemote: false,
        admitLocal: () => status,
        probeRemote: unexpected,
        runLocal: unexpected,
        runRemote: unexpected,
        report: unexpected,
      }),
    ).toBe(status);
  },
);
test.each([0, BOTH_GATES_REFUSED])(
  "remote invocation still admits locally without recursive offload: %i",
  (status) => {
    const events: string[] = [];
    const unexpected = () => {
      throw new TypeError("unexpected remote offload");
    };
    expect(
      withCheckAdmission({
        alreadyRemote: true,
        admitLocal: () => {
          events.push("admit");
          return status;
        },
        probeRemote: unexpected,
        runLocal: () => {
          events.push("local");
          return 0;
        },
        runRemote: unexpected,
        report: (message) => events.push(message),
      }),
    ).toBe(status);
    expect(events).toEqual([
      "admit",
      ...(status === 0 ? ["local"] : [BOTH_GATES_MESSAGE]),
    ]);
  },
);
for (const alreadyRemote of [false, true]) {
  for (const probe of [0, BOTH_GATES_REFUSED, 1, 2, 64, 127, 255]) {
    for (const remote of [0, 1, BOTH_GATES_REFUSED]) {
      test(`late local refusal follows remote admission (alreadyRemote=${alreadyRemote}, probe=${probe}, remote=${remote})`, () => {
        const events: string[] = [];
        const status = withCheckAdmission({
          alreadyRemote,
          admitLocal: () => {
            events.push("admit");
            return 0;
          },
          runLocal: () => {
            events.push("local");
            return BOTH_GATES_REFUSED;
          },
          probeRemote: () => {
            events.push("probe");
            return probe;
          },
          runRemote: () => {
            events.push("remote");
            return remote;
          },
          report: (message) => events.push(message),
        });
        if (alreadyRemote) {
          expect(status).toBe(BOTH_GATES_REFUSED);
          expect(events).toEqual(["admit", "local", BOTH_GATES_MESSAGE]);
        } else if (probe !== 0) {
          expect(status).toBe(probe);
          expect(events).toEqual([
            "admit",
            "local",
            "probe",
            ...(probe === BOTH_GATES_REFUSED ? [BOTH_GATES_MESSAGE] : []),
          ]);
        } else {
          expect(status).toBe(remote);
          expect(events).toEqual([
            "admit",
            "local",
            "probe",
            "remote",
            ...(remote === BOTH_GATES_REFUSED ? [BOTH_GATES_MESSAGE] : []),
          ]);
        }
      });
    }
  }
}

test("local admission forwards actual command argv through the stable load-admit protocol", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "verify-admission-"));
  try {
    const gate = path.join(temporary, "gate.sh");
    const receipt = path.join(temporary, "argv");
    writeFileSync(
      gate,
      `receipt=$1
shift
printf '%s\\0' "$@" > "$receipt"
exit 75
`,
    );
    const command = [
      "bash",
      "-c",
      "bun run code-check:affected\nbun run typecheck",
    ];
    expect(
      admitLocal({
        config: {
          localGate: ["bash", gate, receipt, "--"],
          remote: ["remote-check"],
          installer: ["serial-install"],
        },
        repo: temporary,
        command,
      }),
    ).toBe(BOTH_GATES_REFUSED);
    expect(readFileSync(receipt, "utf-8").split("\0").slice(0, -1)).toEqual([
      "--",
      ...command,
    ]);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
test("verify executes every marked CI step and nothing else", () => {
  const steps = readVerifyWorkflow({ root, mode: "verify" });
  const executed: VerifyWorkflowStep[] = [];
  expect(
    runVerifySteps(steps, (step) => {
      executed.push(step);
      return 0;
    }),
  ).toBe(0);
  expect(executed).toEqual(steps);
  for (const command of [
    "code-check:affected",
    "typecheck-baseline.ts --check-delta",
    "refresh-test-durations.ts --check",
    "ratchet.ts --check",
    "design-lint-baseline.ts --check",
  ]) {
    expect(
      steps.some(({ run }) => run.includes(command)),
      command,
    ).toBe(true);
  }
});
test("fix mode executes exact autofix workflow blocks", () => {
  const steps = readVerifyWorkflow({ root, mode: "autofix" });
  const executed: VerifyWorkflowStep[] = [];
  expect(
    runAutofixSteps(steps, (step) => {
      executed.push(step);
      return 0;
    }),
  ).toBe(0);
  expect(executed).toEqual(steps);
  const lint = steps.find(({ run }) => run.includes("oxlint"));
  expect(lint).toBeDefined();
  if (lint === undefined) {
    throw new VerifyError("Marked autofix must include the lint fixer");
  }
  for (const command of [
    "set -euo pipefail",
    "ci-generated-sources.ts prepare",
    "typecheck-coverage.ts --autofix",
    "--type-aware --fix",
  ]) {
    expect(lint.run).toContain(command);
  }
  expect(lint.run.indexOf("ci-generated-sources.ts prepare")).toBeLessThan(
    lint.run.indexOf("typecheck-coverage.ts --autofix"),
  );
  expect(lint.run.indexOf("typecheck-coverage.ts --autofix")).toBeLessThan(
    lint.run.indexOf("--type-aware --fix"),
  );
  expect(
    steps.some(({ run }) =>
      run.includes("refresh-test-durations.ts --add-missing"),
    ),
  ).toBe(true);
  expect(steps.some(({ run }) => run.includes("oxfmt"))).toBe(true);
  expect(parseVerifyArgs(["--fix"])).toMatchObject({ mode: "fix-check" });
});
test("preparation and fixer failures abort before subsequent commands", () => {
  for (const mode of ["verify", "autofix"] as const) {
    const steps = readVerifyWorkflow({ root, mode });
    const executed: VerifyWorkflowStep[] = [];
    const run = (step: VerifyWorkflowStep) => {
      executed.push(step);
      return 2;
    };
    expect(
      mode === "verify"
        ? runVerifySteps(steps, run)
        : runAutofixSteps(steps, run),
    ).toBe(2);
    expect(executed).toEqual(steps.slice(0, 1));
  }
});
test.each([false, true])(
  "a check refusal stops the plan and preserves admission fallback (remote=%s)",
  (alreadyRemote) => {
    const steps = readVerifyWorkflow({ root, mode: "verify" });
    const executed: VerifyWorkflowStep[] = [];
    const messages: string[] = [];
    let remoteRuns = 0;
    expect(
      withCheckAdmission({
        alreadyRemote,
        admitLocal: () => 0,
        probeRemote: () => 0,
        runLocal: () =>
          runVerifySteps(steps, (step) => {
            executed.push(step);
            return step.phase === "check" ? BOTH_GATES_REFUSED : 0;
          }),
        runRemote: () => {
          remoteRuns += 1;
          return 0;
        },
        report: (message) => messages.push(message),
      }),
    ).toBe(alreadyRemote ? BOTH_GATES_REFUSED : 0);
    const firstCheck = steps.findIndex(({ phase }) => phase === "check");
    expect(firstCheck).toBeGreaterThanOrEqual(0);
    expect(executed).toEqual(steps.slice(0, firstCheck + 1));
    expect(remoteRuns).toBe(alreadyRemote ? 0 : 1);
    expect(messages).toEqual(alreadyRemote ? [BOTH_GATES_MESSAGE] : []);
  },
);

test("options reject unknown arguments and missing refs", () => {
  expect(parseVerifyArgs(["--base", "upstream/main", "--all"])).toEqual({
    base: "upstream/main",
    scope: "all",
    mode: "check",
  });
  for (const { args, message } of [
    { args: ["--base"], message: "--base requires a ref" },
    { args: ["--base", "--all"], message: "--base requires a ref" },
    { args: ["--unknown"], message: "Unknown verify argument: --unknown" },
  ]) {
    expect(() => parseVerifyArgs(args)).toThrow(message);
  }
});

for (const conflict of [false, true]) {
  test(`remote fixes apply only to the matching local tree (conflict=${conflict})`, () => {
    const fixture = realpathSync(
      mkdtempSync(path.join(tmpdir(), "verify-remote-")),
    );
    try {
      mkdirSync(path.join(fixture, "scripts"));
      mkdirSync(path.join(fixture, ".github/workflows"), { recursive: true });
      for (const file of [
        "verify.ts",
        "verify-admission.ts",
        "verify-workflow.ts",
        "verify-error.ts",
        "workflow-steps.ts",
      ]) {
        copyFileSync(
          path.join(root, "scripts", file),
          path.join(fixture, "scripts", file),
        );
      }
      writeFileSync(
        path.join(fixture, ".github/workflows/ci.yml"),
        "jobs:\n  fixture:\n    steps:\n      - name: Check\n        env: { STELLA_VERIFY: check }\n        run: echo check\n",
      );
      writeFileSync(
        path.join(fixture, ".github/workflows/autofix.yml"),
        'jobs:\n  fixture:\n    steps:\n      - name: Fix\n        env: { STELLA_LOCAL_AUTOFIX: "true" }\n        run: echo fix\n',
      );
      const git = (args: string[]) => {
        const result = Bun.spawnSync(["git", ...args], {
          cwd: fixture,
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        return result.stdout.toString().trim();
      };
      git(["init", "-q"]);
      writeFileSync(path.join(fixture, "target.txt"), "baseline\n");
      git(["add", "target.txt"]);
      git([
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "fixture",
      ]);
      const mergeBase = git(["rev-parse", "HEAD"]);
      git(["update-ref", "refs/remotes/upstream/main", mergeBase]);
      writeFileSync(path.join(fixture, "target.txt"), "user edit\n");
      const patch =
        "diff --git a/target.txt b/target.txt\n--- a/target.txt\n+++ b/target.txt\n@@ -1 +1 @@\n-user edit\n+fixed user edit\n";
      const receipt = `STELLA_VERIFY_PATCH=${Buffer.from(patch).toString("base64")}`;
      writeFileSync(
        path.join(fixture, "remote.sh"),
        `#!/bin/sh\nif [ "$1" = --probe ]; then exit 0; fi\nprintf '%s\\0' "$@" > remote-argv\n${conflict ? "printf 'concurrent edit\\n' > target.txt\n" : ""}printf '%s\\n' '${receipt}'\n`,
      );
      const config = path.join(fixture, "config.json");
      writeFileSync(
        config,
        JSON.stringify({
          localGate: ["bash", "-c", "exit 75"],
          remote: ["bash", path.join(fixture, "remote.sh")],
        }),
      );
      const result = Bun.spawnSync(
        [
          process.execPath,
          "scripts/verify.ts",
          "--fix-only",
          "--base",
          "upstream/main",
        ],
        {
          cwd: fixture,
          env: {
            ...process.env,
            STELLA_VERIFY_CONFIG: config,
            REMOTE_CHECK: undefined,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(conflict ? 2 : 0);
      expect(
        readFileSync(path.join(fixture, "remote-argv"), "utf-8")
          .split("\0")
          .slice(0, -1),
      ).toEqual([
        fixture,
        "--",
        "bash",
        "scripts/verify.sh",
        "--fix-only",
        "--base",
        mergeBase,
        "--emit-fix-patch",
      ]);
      expect(git(["rev-parse", "upstream/main"])).toBe(mergeBase);
      expect(readFileSync(path.join(fixture, "target.txt"), "utf-8")).toBe(
        conflict ? "concurrent edit\n" : "fixed user edit\n",
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}

test.each(["true", "false"])(
  "marked generated preparation uses the existing owner with local=%s",
  (local) => {
    const temporary = mkdtempSync(path.join(tmpdir(), "verify-generation-"));
    try {
      const step = readVerifyWorkflow({ root, mode: "verify" }).find(
        ({ job, name }) =>
          job === "ci-generated-sources" &&
          name === "Produce generated sources",
      );
      if (step === undefined) {
        throw new TypeError("Marked generated preparation is missing");
      }
      const stub = path.join(temporary, "bun");
      const argvReceipt = path.join(temporary, "argv");
      const manifestReceipt = path.join(temporary, "manifest");
      writeFileSync(
        stub,
        `#!/bin/sh
printf '%s\\0' "$@" > "$ARGV_RECEIPT"
printf '%s' "\${CI_GENERATED_SOURCES_MANIFEST-unset}" > "$MANIFEST_RECEIPT"
`,
      );
      chmodSync(stub, 0o755);
      const result = Bun.spawnSync(
        ["bash", "-euo", "pipefail", "-c", step.run],
        {
          cwd: path.resolve(root, step.cwd),
          env: {
            ...process.env,
            ...step.env,
            PATH: `${temporary}:${process.env["PATH"] ?? ""}`,
            STELLA_VERIFY_LOCAL: local,
            RUNNER_TEMP: temporary,
            CI_GENERATED_SOURCES_MANIFEST: "/stale/manifest",
            ARGV_RECEIPT: argvReceipt,
            MANIFEST_RECEIPT: manifestReceipt,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(
        readFileSync(argvReceipt, "utf-8").split("\0").slice(0, -1),
      ).toEqual(
        local === "true"
          ? ["scripts/ci-generated-sources.ts", "prepare"]
          : [
              "scripts/ci-generated-sources.ts",
              "produce",
              `${temporary}/generated-sources`,
            ],
      );
      expect(readFileSync(manifestReceipt, "utf-8")).toBe(
        local === "true" ? "unset" : "/stale/manifest",
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);

test("host configuration owns gate separators and validates installer argv", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "verify-host-config-"));
  try {
    for (const file of ["verify-admission.ts", "verify-error.ts"]) {
      copyFileSync(path.join(root, "scripts", file), path.join(fixture, file));
    }
    writeFileSync(
      path.join(fixture, "host-config-fixture.ts"),
      `
import { admitLocal, hostConfig } from "./verify-admission.ts";
const config = hostConfig();
console.log(JSON.stringify(config));
if (process.argv[2] === "admit") {
  process.exit(admitLocal({
    config,
    repo: process.cwd(),
    command: ["bash", "-c", "echo fixture"],
  }));
}
`,
    );
    const gate = path.join(fixture, "load-admit");
    const receipt = path.join(fixture, "argv");
    writeFileSync(
      gate,
      `#!/bin/sh
printf '%s\\0' "$@" > "$ADMISSION_RECEIPT"
`,
    );
    chmodSync(gate, 0o755);
    const configFile = path.join(fixture, "config.json");
    const configured = {
      localGate: [gate, "--"],
      remote: ["remote-check"],
      installer: [path.join(fixture, "serial installer.sh")],
    };
    const run = (mode: "admit" | "config") =>
      Bun.spawnSync([process.execPath, "host-config-fixture.ts", mode], {
        cwd: fixture,
        env: {
          ...process.env,
          STELLA_VERIFY_CONFIG: configFile,
          ADMISSION_RECEIPT: receipt,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
    writeFileSync(configFile, JSON.stringify(configured));
    const admitted = run("admit");
    expect(admitted.exitCode, admitted.stderr.toString()).toBe(0);
    expect(JSON.parse(admitted.stdout.toString())).toEqual(configured);
    expect(readFileSync(receipt, "utf-8").split("\0").slice(0, -1)).toEqual([
      "--",
      "bash",
      "-c",
      "echo fixture",
    ]);

    writeFileSync(configFile, "{}");
    const defaults = run("config");
    expect(defaults.exitCode, defaults.stderr.toString()).toBe(0);
    expect(JSON.parse(defaults.stdout.toString())).toEqual({
      localGate: ["load-admit", "--"],
      remote: ["remote-check"],
      installer: ["serial-install"],
    });

    for (const field of ["localGate", "remote", "installer"]) {
      writeFileSync(
        configFile,
        JSON.stringify({ ...configured, [field]: ["bad\0argument"] }),
      );
      const rejected = run("config");
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.stderr.toString()).toContain(
        `${field} must be a nonempty command array`,
      );
    }
    for (const installer of [[], "serial-install"]) {
      writeFileSync(configFile, JSON.stringify({ ...configured, installer }));
      const rejected = run("config");
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.stderr.toString()).toContain(
        "installer must be a nonempty command array",
      );
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
