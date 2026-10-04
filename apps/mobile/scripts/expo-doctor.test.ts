import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { classifyExpoDoctorResult } from "./expo-doctor";

const BUN_DUPLICATE_OUTPUT = `Running 21 checks on your project...
20/21 checks passed. 1 checks failed. Possible issues detected:

✖ Check that no duplicate dependencies are installed
Found duplicates for expo:
  ├─ expo@57.0.13 (at: node_modules/expo)
  └─ expo@57.0.13 (at: ../../node_modules/.bun/expo@57.0.13+abc/node_modules/expo)
Found duplicates for expo-constants:
  ├─ expo-constants@57.0.11 (at: node_modules/expo-constants)
  └─ expo-constants@57.0.11 (at: ../../../../../.bun/install/cache/links/expo@57.0.13-abc/node_modules/expo-constants)

1 check failed, indicating possible issues with the project.`;

describe("Expo Doctor Bun-store compatibility guard", () => {
  test("passes a successful Doctor run unchanged", () => {
    expect(classifyExpoDoctorResult("21/21 checks passed.", 0)).toEqual({
      type: "pass",
    });
  });

  test("accepts only same-version dependency groups backed by Bun stores", () => {
    expect(classifyExpoDoctorResult(BUN_DUPLICATE_OUTPUT, 1)).toEqual({
      type: "known-bun-store-layout",
      packages: ["expo", "expo-constants"],
    });
  });

  test("rejects a real duplicate-version conflict", () => {
    const output = BUN_DUPLICATE_OUTPUT.replace(
      "└─ expo@57.0.13 (at:",
      "└─ expo@56.0.0 (at:",
    );
    expect(classifyExpoDoctorResult(output, 1)).toEqual({
      type: "failure",
      reason: "expo resolves to multiple versions",
    });
  });

  test("rejects any additional Doctor failure", () => {
    const output = `${BUN_DUPLICATE_OUTPUT}\n✖ Check package versions`;
    expect(classifyExpoDoctorResult(output, 1)).toEqual({
      type: "failure",
      reason:
        "Expo Doctor reported a failure other than the known Bun store layout",
    });
  });

  test("rejects duplicates outside the project and Bun stores", () => {
    const output = BUN_DUPLICATE_OUTPUT.replace(
      "../../node_modules/.bun/expo@57.0.13+abc/node_modules/expo",
      "../../vendor/expo",
    );
    expect(classifyExpoDoctorResult(output, 1)).toEqual({
      type: "failure",
      reason: "expo has no Bun store resolution",
    });
  });
});

test("known Doctor output is accepted only after ordinary child termination", () => {
  expect(classifyExpoDoctorResult(BUN_DUPLICATE_OUTPUT, 1).type).toBe(
    "known-bun-store-layout",
  );
  const directory = mkdtempSync(
    path.join(tmpdir(), "expo-doctor-termination-"),
  );
  const binaries = path.join(directory, "node_modules/.bin");
  mkdirSync(binaries, { recursive: true });
  try {
    for (const termination of ["ordinary", "signal"]) {
      writeFileSync(
        path.join(binaries, "expo-doctor"),
        `#!/usr/bin/env bun
await Bun.write(Bun.stdout, ${JSON.stringify(BUN_DUPLICATE_OUTPUT)});
${termination === "signal" ? 'process.kill(process.pid, "SIGTERM");' : "process.exit(1);"}
`,
        { mode: 0o755 },
      );
      const result = Bun.spawnSync(
        [
          process.execPath,
          "--no-env-file",
          path.join(import.meta.dir, "expo-doctor.ts"),
          directory,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(result.stdout.toString()).toContain(BUN_DUPLICATE_OUTPUT);
      expect(result.exitCode, result.stderr.toString()).toBe(
        termination === "ordinary" ? 0 : 1,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
