import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("compiled image probe indexes an edition and screens it from the external matcher bundle", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "sanctions-image-smoke-"),
  );
  try {
    const workers = path.join(directory, "workers");
    await mkdir(workers);
    const workerBuild = await Bun.build({
      entrypoints: [
        path.resolve(
          import.meta.dir,
          "../lib/lists/sanctions/sanctions-matcher-worker.ts",
        ),
      ],
      naming: "sanctions-matcher-worker.js",
      outdir: workers,
      target: "bun",
    });
    expect(workerBuild.success, JSON.stringify(workerBuild.logs)).toBe(true);
    const entrypoint = path.join(directory, "probe.ts");
    await writeFile(
      entrypoint,
      `import { checkBundledSanctionsMatcher } from ${JSON.stringify(path.join(import.meta.dir, "image-smoke-sanctions.ts"))}; await checkBundledSanctionsMatcher();`,
    );
    const binary = path.join(directory, "probe");
    const build = Bun.spawn(
      [process.execPath, "build", "--compile", entrypoint, "--outfile", binary],
      { cwd: directory, stdout: "pipe", stderr: "pipe" },
    );
    const [buildOutput, buildError, built] = await Promise.all([
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
      build.exited,
    ]);
    expect(built, `${buildOutput}\n${buildError}`).toBe(0);
    const child = Bun.spawn([binary], {
      cwd: directory,
      env: { PATH: process.env["PATH"] ?? "", STELLA_WORKER_DIR: workers },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    });
    const [output, error, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit, `${output}\n${error}`).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
