import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Script } from "node:vm";

import { rejectionOf } from "@stll/property-testing/rejection";
import { createProgram } from "@stll/scripts/src/typescript-program";

import {
  generateCapabilityCatalogRuntime,
  generateCapabilityRuntime,
} from "./generate-capability-runtime";
import { serializeDispatchModule } from "./lib/capability-catalog";

const catalogSourceUrl = new URL(
  "export-capability-catalog.ts",
  import.meta.url,
);

const catalogMainPrefix = async () => {
  const source = await readFile(catalogSourceUrl, "utf-8");
  const startMarker =
    'export const exportCapabilityCatalog = async (\n  mode: "write" | "check",\n): Promise<number> => {';
  const start = source.indexOf(startMarker);
  const end = source.indexOf("  const { entries, errors", start);
  if (start === -1 || end === -1) {
    throw new TypeError("Catalog main bootstrap boundaries were not found");
  }
  return source
    .slice(start + startMarker.length, end)
    .replaceAll("import.meta.url", () => JSON.stringify(catalogSourceUrl.href));
};

type BootstrapOptions = {
  source: string;
  prepared: boolean;
  generate: () => Promise<void>;
  buildCatalog: () => Promise<void>;
};

const executeBootstrap = ({
  source,
  prepared,
  generate,
  buildCatalog,
}: BootstrapOptions) =>
  new Script(
    `(async () => { ${source}\nawait buildCatalog(); })()`,
  ).runInNewContext({
    URL,
    mode: "check",
    hasPreparedGeneratedSources: () => prepared,
    generateCapabilityCatalogRuntime: generate,
    buildCatalog,
  });

test("prepared catalog export reaches catalog construction without regenerating runtime sources", async () => {
  const events: string[] = [];
  await executeBootstrap({
    source: await catalogMainPrefix(),
    prepared: true,
    generate: async () => {
      events.push("generate");
    },
    buildCatalog: async () => {
      events.push("catalog");
    },
  });
  expect(events).toEqual(["catalog"]);
});

test.each(["fixture-feature", undefined])(
  "derived API imports deterministically bundle complete shard data and lazy handlers with feature %s",
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
      const bootstrap = await catalogMainPrefix();
      const missingBootstrap = bootstrap.replace(
        "await generateCapabilityCatalogRuntime();",
        "",
      );
      expect(missingBootstrap).not.toBe(bootstrap);
      const buildCatalog = async () => {
        await readFile(
          new URL(`${generated}/capability-feature-bindings.ts`, root),
          "utf-8",
        );
      };
      expect(
        await rejectionOf(
          executeBootstrap({
            source: missingBootstrap,
            prepared: false,
            generate: async () => generateCapabilityCatalogRuntime(root),
            buildCatalog,
          }),
        ),
      ).toMatchObject({ code: "ENOENT" });
      await executeBootstrap({
        source: bootstrap,
        prepared: false,
        generate: async () => generateCapabilityCatalogRuntime(root),
        buildCatalog,
      });
      const first = await readFile(
        new URL(`${generated}/capability-catalog.ts`, root),
        "utf-8",
      );
      await generateCapabilityRuntime(root);
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
