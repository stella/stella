import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { installTimeoutMs } from "./ci-install";
import { installClassKey, measuredInstallBudget } from "./ci-install-budgets";
import measurements from "./ci-install-measurements.json" with { type: "json" };
import {
  boundedInstallProblems,
  installWorkflowPolicy,
} from "./ci-install-policy";

const postgres = {
  platform: "linux",
  flags: [
    "--frozen-lockfile",
    "--ignore-scripts",
    "--filter",
    "@stll/api",
    "--filter",
    "@stll/cli",
  ],
} as const;

test("cold p95 budgets include a margin and exclude warm and censored samples", () => {
  const budget = measuredInstallBudget(postgres);
  expect(budget.p95Ms).toBe(13_138);
  expect(budget.timeoutMs).toBe(74_000);
  expect(budget.timeoutMs).toBeGreaterThanOrEqual(
    13_138 + measurements.marginMs,
  );
  const noisy = {
    ...measurements,
    classes: measurements.classes.map((entry) => ({
      ...entry,
      samples: [
        ...entry.samples,
        ...["timeout", "completed"].map((outcome) => ({
          runId: 1,
          jobId: 2,
          bunVersion: "fixture",
          cache: outcome === "completed" ? "warm" : "cold",
          outcome,
          durationMs: 3_600_000,
        })),
      ],
    })),
  };
  expect(measuredInstallBudget(postgres, noisy)).toEqual(budget);
  const ranked = {
    ...measurements,
    classes: measurements.classes.map((entry) => ({
      ...entry,
      samples: [
        ...Array.from({ length: 20 }, (_, index) => index + 1),
        50_000,
      ].map((durationMs) => ({
        runId: 1,
        jobId: 2,
        bunVersion: "fixture",
        cache: "cold",
        outcome: "completed",
        durationMs,
      })),
    })),
  };
  expect(measuredInstallBudget(postgres, ranked).p95Ms).toBe(20);
});

test("unmeasured existing classes retain their platform limits", () => {
  for (const entry of measurements.classes) {
    expect(["measured", "unmeasured"]).toContain(entry.status);
    expect(entry.reason.trim().length).toBeGreaterThan(0);
    if (entry.status !== "unmeasured") {
      continue;
    }
    const platform = entry.key.startsWith("win32|") ? "win32" : "linux";
    expect(entry.currentBudgetMs).toBe(installTimeoutMs(platform));
    expect(
      entry.samples.filter(
        (sample) => sample.cache === "cold" && sample.outcome === "completed",
      ),
    ).toEqual([]);
  }
  expect(
    measuredInstallBudget({
      platform: "win32",
      flags: ["--frozen-lockfile", "--ignore-scripts"],
    }).timeoutMs,
  ).toBe(240_000);
});

test("class discovery normalizes equivalent filters but distinguishes new scopes and flags", () => {
  expect(installClassKey(postgres)).toBe(
    installClassKey({
      platform: "linux",
      flags: [
        "--filter=@stll/cli",
        "--ignore-scripts",
        "--filter=@stll/api",
        "--frozen-lockfile",
      ],
    }),
  );
  expect(
    installClassKey({ platform: "linux", flags: ["-g", "turbo@$(…)"] }),
  ).toBe(
    installClassKey({ platform: "linux", flags: ["--global", "turbo@2.11.6"] }),
  );
  for (const flags of [
    [...postgres.flags, "--filter", "@stll/new-package"],
    [...postgres.flags, "--production"],
    [...postgres.flags, "--backend", "copyfile"],
  ]) {
    expect(() => measuredInstallBudget({ platform: "linux", flags })).toThrow(
      "Missing install class measurement entry",
    );
  }
  expect(() =>
    measuredInstallBudget({ platform: "darwin", flags: postgres.flags }),
  ).toThrow("Missing install class measurement entry");
});

test("every real CI installer is bound to a measurement entry", () => {
  const root = path.resolve(import.meta.dir, "..");
  for (const filename of new Bun.Glob("*.yml").scanSync({
    cwd: path.join(root, ".github/workflows"),
  })) {
    const policy = installWorkflowPolicy(filename);
    if (policy.type !== "check") {
      continue;
    }
    const workflow: unknown = Bun.YAML.parse(
      readFileSync(path.join(root, ".github/workflows", filename), "utf-8"),
    );
    expect(boundedInstallProblems(workflow, policy.scope), filename).toEqual(
      [],
    );
  }
  expect(new Set(measurements.classes.map((entry) => entry.key)).size).toBe(
    measurements.classes.length,
  );
});

test("a new install class fails the workflow guard even in a parallel group", () => {
  const upload = {
    uses: "actions/upload-artifact@fixture",
    if: "failure()",
    with: { path: `\${{ runner.temp }}/bun-install/*.log` },
  };
  const workflow = (runner: string, flags: string) => ({
    jobs: {
      fixture: {
        "runs-on": runner,
        "timeout-minutes": 15,
        steps: [
          {
            parallel: [
              {
                "timeout-minutes": 3,
                run: `bun scripts/ci-install.ts "$RUNNER_TEMP/bun-install/fixture.log" --frozen-lockfile --ignore-scripts ${flags}`,
              },
            ],
          },
          upload,
        ],
      },
    },
  });
  expect(
    boundedInstallProblems(
      workflow("ubuntu-latest", "--filter @stll/api --filter @stll/cli"),
      "all",
    ),
  ).toEqual([]);
  for (const [runner, flags] of [
    ["ubuntu-latest", "--filter @stll/new-package"],
    ["macos-latest", "--filter @stll/api --filter @stll/cli"],
  ] as const) {
    expect(
      boundedInstallProblems(workflow(runner, flags), "all").some((problem) =>
        problem.includes("Missing install class measurement entry"),
      ),
    ).toBe(true);
  }
  const otherMatrixFields = workflow(
    "ubuntu-latest",
    "--filter @stll/api --filter @stll/cli",
  );
  const matrix = { runner: ["ubuntu-latest"], description: ["windows"] };
  expect(
    boundedInstallProblems(
      {
        jobs: {
          fixture: { ...otherMatrixFields.jobs.fixture, strategy: { matrix } },
        },
      },
      "all",
    ),
  ).toEqual([]);
  expect(
    boundedInstallProblems(
      workflow("macos-latest", "--filter @stll/api --filter @stll/cli"),
      "windows",
    ).some((problem) =>
      problem.includes("Missing install class measurement entry"),
    ),
  ).toBe(true);
});
