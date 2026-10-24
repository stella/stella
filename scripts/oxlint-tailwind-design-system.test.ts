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

// The plugin loads the design system in worker threads and blocks on them.
// Each bounded wait below expires once before its worker answers: the state a
// loaded runner reaches when a load outlasts any deadline. Lint must wait the
// load out and then judge the classes exactly, instead of failing on the clock.
// The clock is replaced by a plugin with no rules, loaded in the same runtime as
// oxlint-tailwindcss before any file is linted.
const expireEachTimedWaitOnce = `
export default { meta: { name: "expire-timed-waits" }, rules: {} };
const wait = Atomics.wait;
const expired = new WeakMap();
Atomics.wait = (array, index, value, timeout) => {
  if (timeout !== undefined && Number.isFinite(timeout) && Atomics.load(array, index) === value) {
    const indices = expired.get(array) ?? new Set();
    if (!indices.has(index)) {
      indices.add(index);
      expired.set(array, indices);
      return "timed-out";
    }
  }
  return wait(array, index, value, timeout);
};
`;

test("a design-system load slower than any deadline delays lint, never fails it", async () => {
  // Inside the repository so `@import "tailwindcss"` resolves.
  const fixtureRoot = path.join(repositoryRoot, "node_modules/.cache");
  await mkdir(fixtureRoot, { recursive: true });
  const directory = await mkdtemp(
    path.join(fixtureRoot, "stella-tailwind-slow-load-"),
  );
  try {
    const entryPoint = path.join(directory, "app.css");
    await Bun.write(entryPoint, '@import "tailwindcss";\n');
    const clock = path.join(directory, "expire-timed-waits.mjs");
    await Bun.write(clock, expireEachTimedWaitOnce);
    // JSON: Node does not strip types from a TypeScript config under
    // node_modules.
    const config = path.join(directory, "oxlintrc.json");
    await Bun.write(
      config,
      JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: [
          clock,
          path.join(repositoryRoot, "node_modules/oxlint-tailwindcss"),
        ],
        settings: { tailwindcss: { entryPoint } },
        rules: {
          "tailwindcss/no-conflicting-classes": "error",
          "tailwindcss/no-unknown-classes": "error",
        },
      }),
    );
    const input = path.join(directory, "input.tsx");
    // Arbitrary values are outside the precomputed class list, so judging
    // them needs the live declarations worker as well as the precompute.
    await Bun.write(
      input,
      'export const A = () => <span className="size-[1em] object-contain bg-red-5000" />;\n',
    );
    const child = Bun.spawn(
      ["bun", "--bun", "oxlint", "-c", config, "--format", "json", input],
      {
        cwd: repositoryRoot,
        stdout: "pipe",
        stderr: "pipe",
        // A cold design-system cache, so the precompute worker runs too.
        env: {
          ...process.env,
          OXLINT_TAILWINDCSS_CACHE_DIR: path.join(directory, "cache"),
        },
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    // Every wait expired, the precompute, the declarations worker's load (the
    // CI failure) and its first answer, and each was only reported as progress.
    const notices = stderr
      .split("\n")
      .filter((line) => line.startsWith("[oxlint-tailwindcss] still waiting"));
    expect(notices, `${stderr}\n${stdout}`).toEqual([
      expect.stringContaining("the design-system precompute of"),
      expect.stringContaining(
        "the declarations worker to load the design system from",
      ),
      expect.stringContaining("a declarations worker response"),
    ]);
    const { diagnostics } = v.parse(diagnosticReport, JSON.parse(stdout));
    expect(
      diagnostics.map(({ code, message }) => `${code} ${message}`),
      stdout,
    ).toEqual([
      expect.stringMatching(
        /^tailwindcss\(no-unknown-classes\) .*"bg-red-5000"/u,
      ),
    ]);
    expect(exitCode).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
