import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { generateCapabilityRuntime } from "./generate-capability-runtime";
import { serializeDispatchModule } from "./lib/capability-catalog";

test("derived API imports are deterministic and bundle the complete shard data and lazy handlers", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "capability-runtime-"));
  const root = pathToFileURL(`${directory}/`);
  const generated = "apps/api/src/mcp/generated";
  const catalog = {
    id: "widgets.list",
    inputSchema: { body: { type: "object" } },
    feature: "preserved",
    featureId: "fixture-feature",
  };
  try {
    for (const child of [
      "packages/cli/capabilities",
      `${generated}/capability-dispatch`,
      "apps/api/src/handlers/widgets",
    ]) {
      await mkdir(path.join(directory, child), { recursive: true });
    }
    await writeFile(
      new URL("packages/cli/capabilities/widgets.list.json", root),
      JSON.stringify(catalog),
    );
    await writeFile(
      new URL("apps/api/src/handlers/widgets/list.ts", root),
      'export default { value: "handler reached" };\n',
    );
    await writeFile(
      new URL(`${generated}/capability-dispatch/widgets.list.ts`, root),
      serializeDispatchModule([
        {
          id: catalog.id,
          importPath: "@/api/handlers/widgets/list",
          exportName: undefined,
        },
      ]),
    );
    await writeFile(
      new URL("tsconfig.json", root),
      JSON.stringify({
        compilerOptions: { paths: { "@/api/*": ["./apps/api/src/*"] } },
      }),
    );
    await generateCapabilityRuntime(root);
    const first = await readFile(
      new URL(`${generated}/capability-catalog.ts`, root),
      "utf-8",
    );
    const firstDispatch = await readFile(
      new URL(`${generated}/capability-dispatch.ts`, root),
      "utf-8",
    );
    await generateCapabilityRuntime(root);
    expect(
      await readFile(
        new URL(`${generated}/capability-catalog.ts`, root),
        "utf-8",
      ),
    ).toBe(first);
    expect(
      await readFile(
        new URL(`${generated}/capability-dispatch.ts`, root),
        "utf-8",
      ),
    ).toBe(firstDispatch);
    await writeFile(
      new URL("entry.ts", root),
      `import { CAPABILITY_FEATURE_BINDINGS } from "./${generated}/capability-feature-bindings";
const catalog = async () => (await import("./${generated}/capability-catalog")).default;
const dispatch = async () => (await import("./${generated}/capability-dispatch")).CAPABILITY_DISPATCH;
process.stdout.write(JSON.stringify({ features: [...CAPABILITY_FEATURE_BINDINGS], catalog: await catalog(), handler: (await (await dispatch())["widgets.list"].load()).default }));\n`,
    );
    const build = await Bun.build({
      entrypoints: [path.join(directory, "entry.ts")],
      target: "bun",
      outdir: path.join(directory, "bundle"),
      tsconfig: path.join(directory, "tsconfig.json"),
    });
    expect(build.success, build.logs.map(String).join("\n")).toBe(true);
    // Remove all inputs before running the bundle: runtime directory reads fail here.
    await rm(path.join(directory, "apps"), { recursive: true });
    await rm(path.join(directory, "packages"), { recursive: true });
    const result = Bun.spawnSync(
      [process.execPath, path.join(directory, "bundle/entry.js")],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      features: [[catalog.id, catalog.featureId]],
      catalog: [catalog],
      handler: { value: "handler reached" },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
