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

type WorkerHook =
  | "busy-load"
  | "busy-request"
  | "slow-heartbeat"
  | "stop-heartbeat"
  | "throw-outside-main";

type WorkerHookOptions = {
  delayMs?: number;
  heartbeatLimitMs: number;
  loadHeartbeatLimitMs?: number;
};

const runWorkerHook = async (
  hook: WorkerHook,
  {
    delayMs = 11_000,
    heartbeatLimitMs,
    loadHeartbeatLimitMs = heartbeatLimitMs,
  }: WorkerHookOptions,
) => {
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
          OXLINT_TAILWINDCSS_WORKER_LOAD_HEARTBEAT_LIMIT_MS:
            String(loadHeartbeatLimitMs),
          OXLINT_TAILWINDCSS_WORKER_TEST_DELAY_MS: String(delayMs),
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
  const result = await runWorkerHook("slow-heartbeat", {
    heartbeatLimitMs: 6000,
  });
  expect(result.stderr).not.toContain("stopped answering");
  expect(result.elapsedMs).toBeGreaterThan(10_000);
  expect(result.exitCode).toBe(1);
  expect(result.diagnostics.map(({ message }) => message)).toEqual([
    expect.stringContaining('"bg-red-5000" is not a valid Tailwind class'),
  ]);
}, 120_000);

test("a worker with a stopped heartbeat fails promptly with its phase", async () => {
  const result = await runWorkerHook("stop-heartbeat", {
    heartbeatLimitMs: 1000,
  });
  expect(result.elapsedMs).toBeLessThan(10_000);
  expect(result.exitCode).toBe(1);
  expect(result.diagnostics.map(({ message }) => message)).toEqual([
    expect.stringContaining(
      "declarations worker stopped answering while compiling the design system",
    ),
  ]);
}, 120_000);

test("a synchronous design-system load uses the longer load heartbeat bound", async () => {
  const result = await runWorkerHook("busy-load", {
    delayMs: 4000,
    heartbeatLimitMs: 1000,
    loadHeartbeatLimitMs: 8000,
  });
  expect(result.stderr).not.toContain("stopped answering");
  expect(result.elapsedMs).toBeGreaterThan(3000);
  expect(result.exitCode).toBe(1);
  expect(result.diagnostics.map(({ message }) => message)).toEqual([
    expect.stringContaining('"bg-red-5000" is not a valid Tailwind class'),
  ]);
}, 120_000);

test("a synchronous design-system load fails at its load heartbeat bound", async () => {
  const result = await runWorkerHook("busy-load", {
    delayMs: 6000,
    heartbeatLimitMs: 1000,
    loadHeartbeatLimitMs: 2000,
  });
  expect(result.elapsedMs).toBeLessThan(5000);
  expect(result.exitCode).toBe(1);
  expect(result.diagnostics.map(({ message }) => message)).toEqual([
    expect.stringContaining(
      "declarations worker stopped answering while compiling the design system",
    ),
  ]);
  expect(result.diagnostics[0]?.message).toContain("app.css");
}, 120_000);

test("a synchronous request loop keeps its own heartbeat alive", async () => {
  const result = await runWorkerHook("busy-request", {
    delayMs: 4000,
    heartbeatLimitMs: 1000,
    loadHeartbeatLimitMs: 8000,
  });
  expect(result.stderr).not.toContain("stopped answering");
  expect(result.elapsedMs).toBeGreaterThan(3000);
  expect(result.exitCode).toBe(1);
  expect(result.diagnostics.map(({ message }) => message)).toEqual([
    expect.stringContaining('"bg-red-5000" is not a valid Tailwind class'),
  ]);
}, 120_000);

test("an exception outside worker main reports its cause immediately", async () => {
  const result = await runWorkerHook("throw-outside-main", {
    heartbeatLimitMs: 10_000,
  });
  expect(result.elapsedMs).toBeLessThan(10_000);
  expect(result.exitCode).toBe(1);
  expect(result.diagnostics.map(({ message }) => message)).toEqual([
    expect.stringContaining("injected worker failure outside main"),
  ]);
}, 120_000);

// The request area is what the shared buffer leaves after its header. A
// request of exactly that size reaches the worker, one byte more is refused
// with its size, never a failed copy. The plugin's own refusal names both numbers, so
// the test derives the limit and the request overhead from it.
const pluginPath = path.join(repositoryRoot, "node_modules/oxlint-tailwindcss");
const TOO_LARGE = /request payload is too large \((\d+) > (\d+) bytes\)/u;

const lintOneClass = async (directory: string, length: number) => {
  const input = path.join(directory, `input-${length}.tsx`);
  await Bun.write(
    input,
    `export const A = () => <span className="${"x".repeat(length)}" />;\n`,
  );
  const child = Bun.spawn(
    [
      "bun",
      "--bun",
      "oxlint",
      "-c",
      path.join(directory, "oxlintrc.json"),
      "--format",
      "json",
      input,
    ],
    { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return `${stdout}\n${stderr}`;
};

test("a request filling the shared request area is answered and one byte more is refused", async () => {
  const fixtureRoot = path.join(repositoryRoot, "node_modules/.cache");
  await mkdir(fixtureRoot, { recursive: true });
  const directory = await mkdtemp(
    path.join(fixtureRoot, "stella-tailwind-request-bound-"),
  );
  try {
    const entryPoint = path.join(directory, "app.css");
    await Bun.write(entryPoint, '@import "tailwindcss";\n');
    await Bun.write(
      path.join(directory, "oxlintrc.json"),
      JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: [pluginPath],
        settings: { tailwindcss: { entryPoint } },
        rules: { "tailwindcss/no-unknown-classes": "error" },
      }),
    );
    const probeLength = 5_000_000;
    const probe = TOO_LARGE.exec(await lintOneClass(directory, probeLength));
    expect(probe, "an oversized request is refused with its size").not.toBe(
      null,
    );
    const requestBytes = Number(probe?.[1]);
    const limit = Number(probe?.[2]);
    const overhead = requestBytes - probeLength;
    // At the limit the request reaches the worker: no size refusal and no
    // failed copy into the shared buffer (the reply has its own bound).
    const atLimit = await lintOneClass(directory, limit - overhead);
    expect(atLimit).not.toMatch(TOO_LARGE);
    expect(atLimit).not.toMatch(
      /RangeError|out of bounds|Source is too large/u,
    );
    expect(atLimit).toContain("tailwindcss(no-unknown-classes)");
    const overLimit = await lintOneClass(directory, limit - overhead + 1);
    expect(TOO_LARGE.exec(overLimit)?.slice(1)).toEqual([
      String(limit + 1),
      String(limit),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
