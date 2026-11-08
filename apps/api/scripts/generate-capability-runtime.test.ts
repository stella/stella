import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createProgram } from "@stll/scripts/src/typescript-program";

import apiPackage from "../package.json";
import {
  generateCapabilityCatalogRuntime,
  generateCapabilityRuntime,
} from "./generate-capability-runtime";
import { serializeDispatchModule } from "./lib/capability-catalog";

test.each(["fixture-feature", undefined])(
  "derived API imports deterministically bundle in-memory contract data without shards and lazy handlers with feature %s",
  async (featureId) => {
    const directory = await mkdtemp(path.join(tmpdir(), "capability-runtime-"));
    const root = pathToFileURL(`${directory}/`);
    const generated = "apps/api/src/mcp/generated";
    const catalog = {
      id: "widgets.list",
      inputSchema: { body: { type: "object" } },
      feature: "preserved",
      featureId,
    };
    try {
      for (const child of [
        `${generated}/capability-dispatch`,
        "apps/api/src/handlers/widgets",
      ]) {
        await mkdir(path.join(directory, child), { recursive: true });
      }
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
      await generateCapabilityCatalogRuntime(root, [catalog]);
      const first = await readFile(
        new URL(`${generated}/capability-catalog.ts`, root),
        "utf-8",
      );
      await generateCapabilityRuntime(root, [catalog]);
      const firstDispatch = await readFile(
        new URL(`${generated}/capability-dispatch.ts`, root),
        "utf-8",
      );
      await generateCapabilityRuntime(root, [catalog]);
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
      const result = Bun.spawnSync(
        [process.execPath, path.join(directory, "bundle/entry.js")],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toEqual({
        features: featureId === undefined ? [] : [[catalog.id, featureId]],
        catalog: [catalog],
        handler: { value: "handler reached" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("capability registry declarations retain ids without importing handler types", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "capability-declarations-"),
  );
  try {
    const dispatch = path.join(directory, "dispatch.ts");
    await writeFile(
      path.join(directory, "handler.ts"),
      'export default { config: { path: "/fixture" } };',
    );
    await writeFile(
      dispatch,
      serializeDispatchModule([
        {
          id: "widgets.list",
          importPath: "@/api/handler",
          exportName: undefined,
        },
      ]),
    );
    const opened = await createProgram({
      rootNames: [dispatch],
      compilerOptions: {
        declaration: true,
        emitDeclarationOnly: true,
        noCheck: true,
        types: [],
        paths: { "@/api/*": [path.join(directory, "*")] },
      },
    });
    try {
      const emitted = await opened.program.getDeclarationEmit([dispatch]);
      expect(emitted.diagnostics).toEqual([]);
      const declaration = [...emitted.outputFiles.values()]
        .map(({ text }) => text)
        .join("\n");
      expect(declaration).toContain('"widgets.list"');
      expect(declaration).toContain("Promise<Record<string, unknown>>");
      expect(declaration).not.toContain("handler");
    } finally {
      await opened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("direct API runtime preparation builds MCP bundles before importing their consumers", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "capability-runtime-order-"),
  );
  try {
    await mkdir(path.join(directory, "apps/api/scripts"), { recursive: true });
    await mkdir(path.join(directory, "scripts"), { recursive: true });
    await writeFile(
      path.join(directory, "apps/api/package.json"),
      JSON.stringify({
        name: "@stll/api",
        scripts: {
          "generate:capability-runtime":
            apiPackage.scripts["generate:capability-runtime"],
        },
      }),
    );
    await writeFile(
      path.join(directory, "scripts/prepare-mcp-apps.ts"),
      `await Bun.write(new URL("../packages/mcp-apps/src/generated/bundles.ts", import.meta.url), 'export const BUNDLES = ["prepared MCP source"];');`,
    );
    await writeFile(
      path.join(directory, "apps/api/scripts/generate-capability-runtime.ts"),
      `import { BUNDLES } from "../../../packages/mcp-apps/src/generated/bundles";
await Bun.write(new URL("../runtime.json", import.meta.url), JSON.stringify(BUNDLES));`,
    );
    const result = Bun.spawnSync(
      [process.execPath, "run", "generate:capability-runtime"],
      {
        cwd: path.join(directory, "apps/api"),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(
      JSON.parse(
        await readFile(path.join(directory, "apps/api/runtime.json"), "utf-8"),
      ),
    ).toEqual(["prepared MCP source"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
