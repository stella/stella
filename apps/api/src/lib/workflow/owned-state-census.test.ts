import { Glob } from "bun";
import { expect, test } from "bun:test";

const SOURCE_ROOT = new URL("../../", import.meta.url).pathname;

const locations = async (pattern: RegExp): Promise<string[]> => {
  const failures: string[] = [];
  for await (const relative of new Glob("**/*.ts").scan({
    cwd: SOURCE_ROOT,
    onlyFiles: true,
  })) {
    if (relative.endsWith(".test.ts")) {
      continue;
    }
    const source = await Bun.file(`${SOURCE_ROOT}/${relative}`).text();
    for (const [index, line] of source.split("\n").entries()) {
      if (pattern.test(line)) {
        if (line.trimEnd().endsWith(";") || line.includes("Extract<")) {
          continue;
        }
        failures.push(`${relative}:${String(index + 1)}: ${line.trim()}`);
      }
    }
  }
  return failures;
};

test("workflow pending and terminal writes have one owner", async () => {
  const pendingWrites = await locations(/contentType:\s*["']pending["']/u);
  expect(pendingWrites, pendingWrites.join("\n")).toEqual([
    expect.stringContaining("lib/workflow-queue.ts"),
  ]);

  const directTerminalWrites = await locations(
    /\.set\(\{\s*content:\s*\{\s*type:\s*["'](?:error|unsupported)["']/u,
  );
  // Reconciliation and the owned settlement writer are the only transition
  // owners. A failure prints the exact source location for the new bypass.
  expect(directTerminalWrites, directTerminalWrites.join("\n")).toEqual([
    expect.stringContaining("lib/workflow/orphan-cells.ts"),
  ]);
});
