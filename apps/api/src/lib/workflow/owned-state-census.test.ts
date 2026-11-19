import { Glob } from "bun";
import { expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const locations = async (pattern: RegExp): Promise<string[]> => {
  const failures: string[] = [];
  for await (const relative of new Glob("**/*.ts").scan({
    cwd: SOURCE_ROOT,
    onlyFiles: true,
  })) {
    if (relative.endsWith(".test.ts")) {
      continue;
    }
    const source = await Bun.file(path.join(SOURCE_ROOT, relative)).text();
    if (pattern.test(source)) {
      failures.push(relative);
    }
  }
  return failures;
};

test("workflow pending and terminal writes have one owner", async () => {
  const pendingWrites = await locations(
    /contentType:\s*["']pending["'](?!\s*;)/u,
  );
  expect(pendingWrites, pendingWrites.join("\n")).toEqual([
    expect.stringContaining("lib/workflow-queue.ts"),
  ]);

  const directTerminalWrites = await locations(
    /\.set\(\{\s*content:\s*\{\s*type:\s*["'](?:error|unsupported)["']/u,
  );
  // Reconciliation and the owned settlement writer are the only transition
  // owners. A failure prints the exact source location for the new bypass.
  expect(directTerminalWrites, directTerminalWrites.join("\n")).toEqual([
    expect.stringContaining("lib/workflow-queue.ts"),
    expect.stringContaining("lib/workflow/orphan-cells.ts"),
  ]);
});
