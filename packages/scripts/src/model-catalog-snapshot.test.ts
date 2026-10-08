import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseOpenRouterReasoningDefaults } from "./model-catalog-capabilities";
import {
  buildCapabilityRows,
  parseModelsDevCapabilities,
  renderCapabilitiesModule,
} from "./model-catalog-capabilities-gen";
import {
  buildModelRateRows,
  parseModelsDevRateRecords,
  renderModelRatesModule,
} from "./model-catalog-rates-gen";
import {
  MODEL_CATALOG_INPUT_DIR,
  reduceModelsDevInput,
  reduceOpenRouterInput,
  serializeCatalogInput,
} from "./model-catalog-snapshot";

const root = path.resolve(import.meta.dir, "../../..");
const generators = [
  { script: "model-catalog-rates-gen.ts", output: "model-rates.gen.ts" },
  {
    script: "model-catalog-capabilities-gen.ts",
    output: "capabilities.gen.ts",
  },
] as const;

describe("committed catalog inputs", () => {
  test("reproduce both outputs and are deterministic reduced fixed points", async () => {
    const modelsDevText = await Bun.file(
      path.join(MODEL_CATALOG_INPUT_DIR, "models.dev.gen.json"),
    ).text();
    const openRouterText = await Bun.file(
      path.join(MODEL_CATALOG_INPUT_DIR, "openrouter.gen.json"),
    ).text();
    const modelsDev: unknown = JSON.parse(modelsDevText);
    const openRouter: unknown = JSON.parse(openRouterText);
    expect(serializeCatalogInput(reduceModelsDevInput(modelsDev))).toBe(
      modelsDevText,
    );
    expect(serializeCatalogInput(reduceOpenRouterInput(openRouter))).toBe(
      openRouterText,
    );
    expect(
      renderModelRatesModule(
        buildModelRateRows(parseModelsDevRateRecords(modelsDev)),
      ),
    ).toBe(
      await Bun.file(
        path.join(root, "packages/ai-catalog/src/model-rates.gen.ts"),
      ).text(),
    );
    expect(
      renderCapabilitiesModule(
        buildCapabilityRows({
          upstream: parseModelsDevCapabilities(modelsDev),
          openRouterDefaults: parseOpenRouterReasoningDefaults(openRouter),
        }),
      ),
    ).toBe(
      await Bun.file(
        path.join(root, "packages/ai-catalog/src/capabilities.gen.ts"),
      ).text(),
    );
  });

  test.each(generators)(
    "$script checks offline and rejects changed output",
    async ({ script, output }) => {
      const directory = await mkdtemp(path.join(tmpdir(), "catalog-offline-"));
      try {
        const sources = path.join(directory, "packages/scripts/src");
        const outputs = path.join(directory, "packages/ai-catalog/src");
        await mkdir(sources, { recursive: true });
        await mkdir(outputs, { recursive: true });
        await symlink(
          path.join(root, "node_modules"),
          path.join(directory, "node_modules"),
          "dir",
        );
        for (const file of [
          "model-catalog-rates-gen.ts",
          "model-catalog-capabilities-gen.ts",
          "model-catalog-capabilities.ts",
          "model-catalog-snapshot.ts",
        ]) {
          await cp(path.join(import.meta.dir, file), path.join(sources, file));
        }
        await cp(
          MODEL_CATALOG_INPUT_DIR,
          path.join(directory, "packages/ai-catalog/upstream"),
          { recursive: true },
        );
        const outputFile = path.join(outputs, output);
        await cp(
          path.join(root, "packages/ai-catalog/src", output),
          outputFile,
        );
        const check = async () => {
          const child = Bun.spawn(
            [
              process.execPath,
              "--preload",
              path.join(root, "scripts/offline-network-preload.ts"),
              path.join(sources, script),
              "--check",
            ],
            { stdout: "pipe", stderr: "pipe" },
          );
          const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          return { code, text: stdout + stderr };
        };
        const current = await check();
        expect(current.text).toContain("current");
        expect(current.code).toBe(0);
        await Bun.write(
          outputFile,
          `${await Bun.file(outputFile).text()}\n// changed output\n`,
        );
        const stale = await check();
        expect(stale.text).toContain("is stale");
        expect(stale.code).toBe(1);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

test("capability refresh rejects before any fetch or write", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "capability-refresh-"));
  try {
    const monitor = path.join(directory, "monitor.ts");
    await Bun.write(
      monitor,
      `
      let fetches = 0;
      let writes = 0;
      globalThis.fetch = () => { fetches++; throw new Error('unexpected fetch'); };
      Bun.write = () => { writes++; throw new Error('unexpected write'); };
      process.on('exit', () => console.log(JSON.stringify({ fetches, writes })));
    `,
    );
    const watched = [
      path.join(MODEL_CATALOG_INPUT_DIR, "models.dev.gen.json"),
      path.join(MODEL_CATALOG_INPUT_DIR, "openrouter.gen.json"),
      ...generators.map(({ output }) =>
        path.join(root, "packages/ai-catalog/src", output),
      ),
    ];
    const before = await Promise.all(
      watched.map((file) => Bun.file(file).text()),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        monitor,
        path.join(import.meta.dir, "model-catalog-capabilities-gen.ts"),
        "--refresh",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("UnsupportedCapabilityRefreshError");
    expect(stderr).toContain("gen:rates --refresh");
    expect(stderr).toContain("gen:capabilities --from-snapshot");
    expect(stdout.trim()).toBe(JSON.stringify({ fetches: 0, writes: 0 }));
    expect(
      await Promise.all(watched.map((file) => Bun.file(file).text())),
    ).toEqual(before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
