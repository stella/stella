import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const diagnosticReport = v.object({
  diagnostics: v.array(
    v.object({
      code: v.string(),
      message: v.string(),
      filename: v.string(),
      severity: v.string(),
    }),
  ),
});

// A design system that cannot load is one failure per rule and linted file.
// The plugin otherwise re-reports it at every class, which reads like a set of
// real class errors. Each rule reports it once with its own severity, keyed by
// the file's parsed tree, so a warning-level rule cannot absorb an error-level
// one and nothing carries over between files.
test("an unavailable Tailwind design system fails as one typed error per rule and file", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "stella-tailwind-design-system-"),
  );
  try {
    const entryPoint = path.join(directory, "broken.css");
    await Bun.write(entryPoint, '@import "./missing-theme.css";\n');
    const config = path.join(directory, "oxlint.config.ts");
    await Bun.write(
      config,
      `export default ${JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: [
          path.join(repositoryRoot, "node_modules/oxlint-tailwindcss"),
        ],
        settings: { tailwindcss: { entryPoint } },
        rules: {
          // A warning-level rule that needs the design system must not absorb
          // the error-level reports.
          "tailwindcss/no-conflicting-classes": "warn",
          "tailwindcss/no-unknown-classes": "error",
          // Duplicate detection needs no design system and reports nothing.
          "tailwindcss/no-duplicate-classes": "error",
        },
      })};`,
    );
    const inputs = ["first.tsx", "second.tsx"].map((name) =>
      path.join(directory, name),
    );
    for (const input of inputs) {
      await Bun.write(
        input,
        [
          'export const A = () => <div className="flex p-2 text-sm" />;',
          'export const B = () => <span className="grid gap-4 font-bold" />;',
          'export const C = () => <p className="mt-1 mb-1 underline" />;',
          "",
        ].join("\n"),
      );
    }
    const child = Bun.spawn(
      ["bun", "--bun", "oxlint", "-c", config, "--format", "json", ...inputs],
      { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).not.toContain("Failed to load");
    expect(exitCode).toBe(1);
    const { diagnostics } = v.parse(diagnosticReport, JSON.parse(stdout));
    expect(
      diagnostics
        .map(
          ({ filename, code, severity }) =>
            `${path.basename(filename)} ${code} ${severity}`,
        )
        .toSorted(),
      stdout,
    ).toEqual(
      ["first.tsx", "second.tsx"].flatMap((file) => [
        `${file} tailwindcss(no-conflicting-classes) warning`,
        `${file} tailwindcss(no-unknown-classes) error`,
      ]),
    );
    for (const { message } of diagnostics) {
      expect(message).toStartWith("tailwind design system not loaded: ");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

type WorkerHook = "slow-heartbeat" | "stop-heartbeat" | "throw-outside-main";

const runWorkerHook = async (hook: WorkerHook, heartbeatLimitMs: number) => {
  const fixtureRoot = path.join(repositoryRoot, "node_modules/.cache");
  await mkdir(fixtureRoot, { recursive: true });
  const directory = await mkdtemp(
    path.join(fixtureRoot, "stella-tailwind-worker-liveness-"),
  );
  try {
    const entryPoint = path.join(directory, "app.css");
    await Bun.write(entryPoint, '@import "tailwindcss";\n');
    const config = path.join(directory, "oxlintrc.json");
    await Bun.write(
      config,
      JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: [
          path.join(repositoryRoot, "node_modules/oxlint-tailwindcss"),
        ],
        settings: { tailwindcss: { entryPoint } },
        rules: { "tailwindcss/no-unknown-classes": "error" },
      }),
    );
    const input = path.join(directory, "input.tsx");
    await Bun.write(
      input,
      'export const A = () => <span className="bg-red-5000" />;\n',
    );
    // Populate the disk precompute before applying the worker-service hook.
    // The hook assertions target the persistent declarations worker, while the
    // precompute path has its own shared liveness protocol.
    const warm = Bun.spawn(
      ["bun", "--bun", "oxlint", "-c", config, "--format", "json", input],
      { cwd: repositoryRoot, stdout: "ignore", stderr: "ignore" },
    );
    await warm.exited;

    const started = performance.now();
    const child = Bun.spawn(
      ["bun", "--bun", "oxlint", "-c", config, "--format", "json", input],
      {
        cwd: repositoryRoot,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          OXLINT_TAILWINDCSS_WORKER_HEARTBEAT_LIMIT_MS:
            String(heartbeatLimitMs),
          OXLINT_TAILWINDCSS_WORKER_TEST_DELAY_MS: "11000",
          OXLINT_TAILWINDCSS_WORKER_TEST_HOOK: hook,
        },
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return {
      diagnostics: v.parse(diagnosticReport, JSON.parse(stdout)).diagnostics,
      elapsedMs: performance.now() - started,
      exitCode,
      stderr,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("a slow worker with a live heartbeat is allowed past the liveness bound", async () => {
  const result = await runWorkerHook("slow-heartbeat", 6000);
  expect(result.stderr).not.toContain("stopped answering");
  expect(result.elapsedMs).toBeGreaterThan(10_000);
  expect(result.exitCode).toBe(1);
  expect(result.diagnostics.map(({ message }) => message)).toEqual([
    expect.stringContaining('"bg-red-5000" is not a valid Tailwind class'),
  ]);
}, 120_000);

test("a worker with a stopped heartbeat fails promptly with its phase", async () => {
  const result = await runWorkerHook("stop-heartbeat", 1000);
  expect(result.elapsedMs).toBeLessThan(10_000);
  expect(result.exitCode).toBe(1);
  expect(result.diagnostics.map(({ message }) => message)).toEqual([
    expect.stringContaining(
      "declarations worker stopped answering while compiling the design system",
    ),
  ]);
}, 120_000);

test("an exception outside worker main reports its cause immediately", async () => {
  const result = await runWorkerHook("throw-outside-main", 10_000);
  expect(result.elapsedMs).toBeLessThan(10_000);
  expect(result.exitCode).toBe(1);
  expect(result.diagnostics.map(({ message }) => message)).toEqual([
    expect.stringContaining("injected worker failure outside main"),
  ]);
}, 120_000);
