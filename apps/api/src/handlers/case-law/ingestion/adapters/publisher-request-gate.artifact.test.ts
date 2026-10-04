import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("the bundled publisher gate reserves without eager Redis initialization", () => {
  const testDir = mkdtempSync(
    path.join(tmpdir(), "stella-publisher-gate-artifact-"),
  );
  const entrypoint = path.join(testDir, "probe.ts");
  const bundle = path.join(testDir, "probe.js");
  const publisherRequestGate = path.join(
    import.meta.dir,
    "publisher-request-gate.ts",
  );

  try {
    writeFileSync(
      entrypoint,
      `import { createPublisherRequestSlot } from ${JSON.stringify(publisherRequestGate)};
let commands = 0;
const reserve = createPublisherRequestSlot({ intervalMs: 1, key: "artifact", publisher: "test" }, {
  redis: () => ({ send: async () => { commands += 1; return 0; } }),
  sleep: async () => {},
});
await reserve();
if (commands !== 1) throw new TypeError("Reservation did not reach the store");
process.stdout.write("reserved");
`,
    );
    const build = Bun.spawnSync({
      cmd: [
        process.execPath,
        "build",
        "--no-autoload-dotenv",
        "--target",
        "bun",
        "--outfile",
        bundle,
        entrypoint,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(build.exitCode, new TextDecoder().decode(build.stderr)).toBe(0);

    const run = Bun.spawnSync({
      cmd: [process.execPath, "--no-autoload-dotenv", bundle],
      env: { PATH: process.env["PATH"] ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
    expect(new TextDecoder().decode(run.stdout)).toBe("reserved");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
}, 30_000);

// Skipping the reservation is a test-harness convenience: every strict
// process reserves, whatever its NODE_ENV, in source and in a release build.
const RESERVES_PROBE = (gateModule: string) =>
  `import { publisherGateReserves } from ${JSON.stringify(gateModule)};
process.stdout.write(String(publisherGateReserves()));
`;

const PROCESS_ENVIRONMENTS = [
  { NODE_ENV: "test" },
  { NODE_ENV: "development" },
  { NODE_ENV: "staging" },
  { NODE_ENV: "production" },
  {},
  { NODE_ENV: "test", STELLA_LOCAL_DEV: "1" },
  { NODE_ENV: "development", STELLA_LOCAL_DEV: "1" },
] as const satisfies readonly Record<string, string>[];

const reservesUnder = (
  command: string[],
  environment: Record<string, string>,
): string => {
  const run = Bun.spawnSync({
    cmd: command,
    env: { PATH: process.env["PATH"] ?? "", ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
  return new TextDecoder().decode(run.stdout);
};

test("every strict process reserves a publisher slot", () => {
  const testDir = mkdtempSync(path.join(tmpdir(), "stella-publisher-gate-"));
  const entrypoint = path.join(testDir, "probe.ts");
  const bundle = path.join(testDir, "probe.js");
  try {
    writeFileSync(
      entrypoint,
      RESERVES_PROBE(path.join(import.meta.dir, "publisher-request-gate.ts")),
    );
    const build = Bun.spawnSync({
      cmd: [
        process.execPath,
        "build",
        "--no-autoload-dotenv",
        "--target",
        "bun",
        "--define",
        "__STELLA_RELEASE__=true",
        "--outfile",
        bundle,
        entrypoint,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(build.exitCode, new TextDecoder().decode(build.stderr)).toBe(0);

    for (const environment of PROCESS_ENVIRONMENTS) {
      const localTestRun =
        "STELLA_LOCAL_DEV" in environment && environment.NODE_ENV === "test";
      expect(
        reservesUnder(
          [process.execPath, "--no-env-file", entrypoint],
          environment,
        ),
        `source ${JSON.stringify(environment)}`,
      ).toBe(String(!localTestRun));
      if (!("STELLA_LOCAL_DEV" in environment)) {
        expect(
          reservesUnder(
            [process.execPath, "--no-env-file", bundle],
            environment,
          ),
          `release bundle ${JSON.stringify(environment)}`,
        ).toBe("true");
      }
    }
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
}, 60_000);
