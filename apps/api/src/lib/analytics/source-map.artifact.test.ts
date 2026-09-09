import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

type StackFrame = {
  location: string;
  symbol: string;
};

const buildAndReadFrame = ({
  entrypoint,
  executable,
}: {
  entrypoint: string;
  executable: string;
}): StackFrame => {
  const build = Bun.spawnSync({
    cmd: [
      process.execPath,
      "build",
      "--compile",
      "--no-compile-autoload-dotenv",
      "--sourcemap=inline",
      "--target",
      "bun",
      "--outfile",
      executable,
      entrypoint,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(build.exitCode, new TextDecoder().decode(build.stderr)).toBe(0);

  const run = Bun.spawnSync({
    cmd: [executable],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
  const line = new TextDecoder().decode(run.stdout).trim();
  const frame = /^at ([^ ]+) \((.+:\d+:\d+)\)$/u.exec(line);
  expect(frame, line).not.toBeNull();
  return {
    symbol: frame?.at(1) ?? "",
    location: frame?.at(2) ?? "",
  };
};

test("compiled source positions survive an unrelated bundler symbol collision", () => {
  const testDir = mkdtempSync(path.join(tmpdir(), "stella-source-map-"));
  const target = path.join(testDir, "target.ts");
  const collider = path.join(testDir, "collider.ts");
  const entryA = path.join(testDir, "entry-a.ts");
  const entryB = path.join(testDir, "entry-b.ts");

  try {
    writeFileSync(
      target,
      'export const run = (): void => { throw new Error("target"); };\n',
    );
    writeFileSync(collider, "export const run = (): void => {};\n");
    writeFileSync(
      entryA,
      [
        'import { run } from "./target";',
        "try { run(); } catch (error) {",
        "  const frame = error instanceof Error ? error.stack?.split('\\n').at(1) : undefined;",
        "  process.stdout.write(frame?.trim() ?? '');",
        "}",
      ].join("\n"),
    );
    writeFileSync(
      entryB,
      [
        'import { run as collidingRun } from "./collider";',
        'import { run } from "./target";',
        "collidingRun();",
        "try { run(); } catch (error) {",
        "  const frame = error instanceof Error ? error.stack?.split('\\n').at(1) : undefined;",
        "  process.stdout.write(frame?.trim() ?? '');",
        "}",
      ].join("\n"),
    );

    const withoutCollision = buildAndReadFrame({
      entrypoint: entryA,
      executable: path.join(testDir, "without-collision"),
    });
    const withCollision = buildAndReadFrame({
      entrypoint: entryB,
      executable: path.join(testDir, "with-collision"),
    });

    // Prove the fixture reaches Bun's rename boundary before asserting that
    // the source position, which is what telemetry keeps, stays fixed.
    expect(withoutCollision.symbol).not.toBe(withCollision.symbol);
    expect(withoutCollision.location).toBe(withCollision.location);
    expect(withCollision.location).toMatch(/target\.ts:1:\d+$/u);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
}, 30_000);
