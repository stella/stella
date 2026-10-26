import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { collectTrackedPaths } from "./tracked-paths";

const encoder = new TextEncoder();
const expectedPathCount = 20_001;
const expectedLastPath = `generated/file-19999-${"x".repeat(80)}.ts`;

// timeout: Allow three Bun probes and their Git children to flush and exit.
test("streams large fragmented tracked paths and rejects incomplete git output", async () => {
  const generatedPaths = Array.from(
    { length: 20_000 },
    (_, index) =>
      `generated/file-${String(index).padStart(5, "0")}-${"x".repeat(80)}.ts\0`,
  ).join("");
  const chunks = [
    encoder.encode("src/caf"),
    new Uint8Array([0xc3]),
    new Uint8Array([0xa9]),
    encoder.encode(`.txt\0${generatedPaths}`),
  ];
  const inventory = await collectTrackedPaths(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    }),
  );
  expect(inventory.decodingError).toBeUndefined();
  expect(inventory.unterminatedPath).toBeUndefined();
  expect(inventory.paths).toHaveLength(expectedPathCount);
  expect(inventory.paths[0]).toBe("src/café.txt");
  expect(inventory.paths.at(-1)).toBe(expectedLastPath);

  const root = mkdtempSync(path.join(tmpdir(), "tracked-paths-"));
  const probe = path.join(root, "probe.ts");
  writeFileSync(
    probe,
    `import { readTrackedPaths } from ${JSON.stringify(path.resolve(import.meta.dirname, "tracked-paths.ts"))};
const mode = process.argv[2];
try {
  const paths = await readTrackedPaths(process.cwd());
  if (mode !== "large") {
    process.stdout.write(JSON.stringify({ returnedPaths: paths }));
    process.exitCode = 1;
  } else {
    process.stdout.write(JSON.stringify({ count: paths.length, first: paths[0], last: paths.at(-1) }));
  }
} catch (error) {
  if (mode === "large") {
    process.stderr.write(String(error));
    process.exitCode = 1;
  } else {
    process.stdout.write(String(error));
  }
}
`,
  );

  const largeOutput = `src/café.txt\0${generatedPaths}`;
  const run = async (
    mode: "large" | "failed" | "unterminated",
    output: string,
    exitCode: number,
  ) => {
    const bin = path.join(root, `bin-${mode}`);
    mkdirSync(bin);
    const git = path.join(bin, "git");
    writeFileSync(
      git,
      [
        "#!/usr/bin/env bun",
        `process.stdout.write(Buffer.from(${JSON.stringify(output)}));`,
        ...(exitCode === 23
          ? ['process.stderr.write("fixture git failure");']
          : []),
        `process.exitCode = ${exitCode};`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const searchPath = [
      bin,
      path.dirname(process.execPath),
      process.env["PATH"],
    ]
      .filter((entry): entry is string => entry !== undefined && entry !== "")
      .join(path.delimiter);
    const child = Bun.spawn([process.execPath, probe, mode], {
      cwd: root,
      env: { ...process.env, PATH: searchPath },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { status, stdout, stderr };
  };

  try {
    const large = await run("large", largeOutput, 0);
    expect(large.status, large.stderr).toBe(0);
    expect(JSON.parse(large.stdout)).toEqual({
      count: expectedPathCount,
      first: "src/café.txt",
      last: expectedLastPath,
    });

    const failed = await run("failed", "src/partial\0", 23);
    expect(failed.status, failed.stderr).toBe(0);
    expect(failed.stdout).toContain('"exitCode":23');
    expect(failed.stdout).toContain("fixture git failure");
    expect(failed.stdout).not.toContain("returnedPaths");

    const unterminated = await run("unterminated", "src/partial", 0);
    expect(unterminated.status, unterminated.stderr).toBe(0);
    expect(unterminated.stdout).toContain("not NUL-terminated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
