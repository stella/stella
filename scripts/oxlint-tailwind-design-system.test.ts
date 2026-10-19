import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const diagnosticReport = v.object({
  diagnostics: v.array(v.object({ code: v.string(), message: v.string() })),
});

// A design system that cannot load is one failure. Without the patched plugin
// every rule call site re-reported it, so a desktop run printed 77 class
// errors for a single worker timeout.
test("an unavailable Tailwind design system fails as one typed error", async () => {
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
          "tailwindcss/no-unknown-classes": "error",
          "tailwindcss/no-conflicting-classes": "error",
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
    expect(diagnostics, stdout).toHaveLength(1);
    expect(diagnostics.at(0)?.message).toStartWith(
      "tailwind design system not loaded: ",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
