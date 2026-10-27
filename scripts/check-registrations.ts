import { panic } from "better-result";
import path from "node:path";

import { API_TEST_TIMEOUT_MS } from "../apps/api/src/tests/test-timeouts";
import { childExitStatus } from "../packages/scripts/src/child-exit-status";
import type { CheckPoolJob } from "./ci-check-pool-registry";

type RegistrationCheck =
  | {
      type: "pool";
      job: CheckPoolJob;
      name: string;
      command: readonly string[];
    }
  | { type: "generator"; id: string; command: readonly string[] }
  | { type: "api-test"; file: string };

export const REGISTRATION_CHECKS = [
  {
    type: "generator",
    id: "failure-tags",
    command: ["bun", "scripts/generate-failure-tags.ts"],
  },
  {
    type: "pool",
    job: "ci-checks-policy",
    name: "Ratchet guard",
    command: ["bun", "scripts/ratchet.ts", "--check"],
  },
  {
    type: "pool",
    job: "ci-checks-policy",
    name: "Deployment feature guard",
    command: [
      "bun",
      "apps/api/scripts/deployment-feature-guard.ts",
      "--base",
      "origin/main",
    ],
  },
  {
    type: "pool",
    job: "ci-checks-rest",
    name: "Module ownership",
    command: ["bun", "scripts/ownership.ts", "--check"],
  },
  {
    type: "pool",
    job: "ci-checks-rest",
    name: "Module ownership invariants",
    command: ["bun", "test", "scripts/ownership.test.ts"],
  },
  {
    type: "pool",
    job: "ci-checks-rest",
    name: "Result boundary enrolment",
    command: ["bun", "run", "check:result-boundary-enrolment"],
  },
  {
    type: "api-test",
    file: "./src/tests/security/route-auth-invariants.test.ts",
  },
  {
    type: "api-test",
    file: "./src/tests/security/matter-access-census.test.ts",
  },
  {
    type: "api-test",
    file: "./src/tests/security/public-response-text-bounds.test.ts",
  },
  { type: "api-test", file: "./src/tests/security/raw-route-census.test.ts" },
  {
    type: "api-test",
    file: "./src/tests/security/cross-tenant-coverage.test.ts",
  },
  { type: "api-test", file: "./src/handlers/tenant-cache-control.test.ts" },
  {
    type: "api-test",
    file: "./src/lib/observability/route-latency-class.test.ts",
  },
  { type: "api-test", file: "./src/tests/read-scaling/census.test.ts" },
  {
    type: "api-test",
    file: "./src/lib/observability/failure-tag-policy.test.ts",
  },
] as const satisfies readonly RegistrationCheck[];

export const registrationCommand = (check: RegistrationCheck) => {
  switch (check.type) {
    case "pool":
    case "generator":
      return {
        cwd: path.resolve(import.meta.dir, ".."),
        command: check.command,
      };
    case "api-test":
      return {
        cwd: path.resolve(import.meta.dir, "../apps/api"),
        command: [
          "bun",
          "test",
          `--timeout=${API_TEST_TIMEOUT_MS}`,
          "--preload",
          "./src/tests/setup-env.ts",
          check.file,
        ],
      };
    default: {
      check satisfies never;
      return panic("Unhandled registration check");
    }
  }
};

if (import.meta.main) {
  const failures: string[] = [];
  const started = performance.now();
  for (const check of REGISTRATION_CHECKS) {
    const { cwd, command } = registrationCommand(check);
    const label = command.join(" ");
    console.log(`\nRegistration check: ${label}`);
    const child = Bun.spawn([...command], {
      cwd,
      stdout: "inherit",
      stderr: "inherit",
    });
    await child.exited;
    if (childExitStatus(child) !== 0) {
      failures.push(label);
    }
  }
  console.log(
    `\nRegistration checks: ${REGISTRATION_CHECKS.length - failures.length}/${REGISTRATION_CHECKS.length} passed; wall time ${((performance.now() - started) / 1000).toFixed(1)} s`,
  );
  for (const failure of failures) {
    console.error(`FAILED registration check: ${failure}`);
  }
  process.exitCode = failures.length === 0 ? 0 : 1;
}
