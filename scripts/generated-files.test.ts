import { panic } from "better-result";
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript6";
import * as v from "valibot";

import { generateCapabilityRuntime } from "../apps/api/scripts/generate-capability-runtime";
import { pinnedParserInputs } from "../packages/catalogue/scripts/pinned-content-facts";
import { repoRelativePath } from "../packages/portable-path/src/index";
import { API_TYPECHECK_REGENERATION_COMMANDS } from "../packages/scripts/src/api-typecheck-regenerate";
import { ciGeneratedFiles } from "../packages/scripts/src/generated-file-inventory";
import { CHECK_POOL_JOBS } from "./ci-check-pool-registry";
import {
  computeChangedFileScope,
  DEFAULT_DETECTORS,
  MODEL_CATALOG_DRIFT_INPUTS,
  ROUTE_TREE_INPUTS,
  type ScopeOutput,
} from "./ci-plan-scope";
import {
  allowedOutputs,
  CI_GENERATED_FILES,
  CI_GENERATED_OUTPUTS,
  derivedPrerequisites,
  GENERATORS,
  generatorsForFiles,
  GUARD_A_EXCLUSIONS,
  matchesGeneratedGlob,
  orderGenerators,
  runGenerators,
} from "./generated-files";
import {
  checkRouteGeneratorVersion,
  isGeneratedCandidate,
  isRegisteredGeneratedFile,
  isUnregisteredGeneratedFile,
  routeGeneratorVersionsMatch,
} from "./generated-files-guard";
import { isChangedLintPath } from "./lint-paths";
import { workflowJobSteps, workflowStepByName } from "./workflow-steps";

const generator = (id: string) => {
  const found = GENERATORS.find((entry) => entry.id === id);
  return found ?? panic(`Missing generator ${id}`);
};

test("Generator output kinds remain literal discriminators after export widening", () => {
  const file = nodePath.resolve(import.meta.dirname, "generator-type-probe.ts");
  const declaration = ts.createSourceFile(
    file,
    readFileSync(
      nodePath.resolve(import.meta.dirname, "generated-files.ts"),
      "utf-8",
    ),
    ts.ScriptTarget.Latest,
    true,
  );
  const definitions = declaration.statements
    .filter(
      (statement) =>
        ts.isTypeAliasDeclaration(statement) &&
        ["Generator", "GeneratorCheck"].includes(statement.name.text),
    )
    .map((statement) => statement.getText(declaration))
    .join("\n");
  const options = { strict: true, noEmit: true, skipLibCheck: true, types: [] };
  const host = ts.createCompilerHost(options);
  const sourceFile = host.getSourceFile;
  host.getSourceFile = (
    name,
    languageVersion,
    onError,
    shouldCreateNewSourceFile,
  ) =>
    name === file
      ? ts.createSourceFile(name, definitions, ts.ScriptTarget.Latest, true)
      : sourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([file], options, host);
  const probe = program.getSourceFile(file);
  if (probe === undefined) {
    throw new Error("Missing generator type probe");
  }
  const generatorType = probe.statements.find(
    (statement) =>
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === "Generator",
  );
  if (
    generatorType === undefined ||
    !ts.isTypeAliasDeclaration(generatorType)
  ) {
    throw new Error("Missing Generator declaration");
  }
  const checker = program.getTypeChecker();
  const generatorUnion = checker.getTypeAtLocation(generatorType);
  if (!generatorUnion.isUnion()) {
    throw new Error("Generator must be a discriminated union");
  }
  const kinds = new Set<string>();
  for (const branch of generatorUnion.types) {
    const discriminator = checker.getPropertyOfType(branch, "outputKind");
    if (discriminator === undefined) {
      throw new Error("Generator branch has no outputKind");
    }
    const kind = checker.getTypeOfSymbolAtLocation(
      discriminator,
      generatorType,
    );
    // A union-valued property recreates TS1360 even if another field forms a union.
    if (!kind.isStringLiteral()) {
      throw new Error(
        "Every Generator branch must retain a literal outputKind",
      );
    }
    kinds.add(kind.value);
  }
  expect(kinds).toEqual(
    new Set(GENERATORS.map(({ outputKind }) => outputKind)),
  );
});

test("generation owners have unique identifiers", () => {
  const ids = GENERATORS.map(({ id }) => id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("glossary and catalogue generation inputs cover their runtime import closures", () => {
  const repoRoot = nodePath.resolve(import.meta.dir, "..");
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  for (const { id, entry } of [
    { id: "i18n-glossary", entry: "packages/scripts/src/glossary-gen.ts" },
    {
      id: "catalogue",
      entry: "packages/catalogue/scripts/generate-manifest.ts",
    },
  ]) {
    const inputs = generator(id).inputs;
    const pending = [entry];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop() ?? panic("Missing import closure entry");
      if (visited.has(file)) {
        continue;
      }
      visited.add(file);
      expect(
        inputs.some((glob) => matchesGeneratedGlob(glob, file)),
        `${id}: ${file}`,
      ).toBe(true);
      for (const { path: specifier } of transpiler.scanImports(
        readFileSync(nodePath.join(repoRoot, file), "utf-8").replace(
          /^#![^\n]*/u,
          "",
        ),
      )) {
        if (!specifier.startsWith(".") && !specifier.startsWith("@stll/")) {
          continue;
        }
        const resolved = Bun.resolveSync(
          specifier,
          nodePath.join(repoRoot, nodePath.dirname(file)),
        );
        pending.push(repoRelativePath(repoRoot, resolved));
      }
    }
  }
});

test("pinned facts generation inputs cover the derived parser graph", () => {
  const inputs = generator("catalogue-pinned-facts").inputs;
  const parserInputs = pinnedParserInputs();
  expect(parserInputs).toContain("packages/skills/src/frontmatter.ts");
  for (const file of parserInputs) {
    expect(
      inputs.some((glob) => matchesGeneratedGlob(glob, file)),
      file,
    ).toBe(true);
  }
});

test("visual source changes select the frame bundle before API catalog generation", () => {
  const selected = orderGenerators(
    generatorsForFiles([
      "apps/api/src/handlers/visual-sandbox/browser/runtime.ts",
    ]),
  );
  const ids = selected.map(({ id }) => id);
  expect(ids).toContain("visual-sandbox-bundle");
  expect(ids.indexOf("visual-sandbox-bundle")).toBeLessThan(
    ids.indexOf("capability-catalog"),
  );
  expect(generator("visual-sandbox-bundle").outputs).toEqual([
    "apps/api/src/handlers/visual-sandbox/generated/runtime.js.txt",
  ]);
});

test("MCP app parser schema imports are registered generation inputs", () => {
  const repoRoot = nodePath.resolve(import.meta.dir, "..");
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const pending = [
    ...new Bun.Glob("packages/mcp-apps/src/*/parse.ts").scanSync(repoRoot),
  ];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || visited.has(file)) {
      continue;
    }
    visited.add(file);
    for (const { path: specifier } of transpiler.scanImports(
      readFileSync(nodePath.join(repoRoot, file), "utf-8").replace(
        /^#![^\n]*/u,
        "",
      ),
    )) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      const dependency = repoRelativePath(
        repoRoot,
        nodePath.resolve(repoRoot, nodePath.dirname(file), `${specifier}.ts`),
      );
      if (!dependency.startsWith("apps/api/src/lib/")) {
        continue;
      }
      for (const id of ["mcp-app-bundles", "cli-registry"]) {
        expect(
          generator(id).inputs.some((glob) =>
            matchesGeneratedGlob(glob, dependency),
          ),
          `${id} covers ${dependency} imported by ${file}`,
        ).toBe(true);
      }
      pending.push(dependency);
    }
  }
});

test("generation metadata loads without dependencies in a reduced checkout", async () => {
  const directory = await mkdtemp(
    nodePath.join(tmpdir(), "generation-metadata-"),
  );
  try {
    const registry = nodePath.join(directory, "scripts/generated-files.ts");
    await mkdir(nodePath.dirname(registry), { recursive: true });
    const inventory = nodePath.join(
      directory,
      "packages/scripts/src/generated-files.ts",
    );
    await mkdir(nodePath.dirname(inventory), { recursive: true });
    await writeFile(
      inventory,
      readFileSync(
        new URL("../packages/scripts/src/generated-files.ts", import.meta.url),
        "utf-8",
      ),
    );
    const source = readFileSync(
      new URL("generated-files.ts", import.meta.url),
      "utf-8",
    );
    await writeFile(registry, source);
    const load = () =>
      Bun.spawnSync(
        [
          process.execPath,
          "-e",
          "const metadata = await import(process.argv[1]); console.log(metadata.CI_GENERATED_FILES.length);",
          registry,
        ],
        { cwd: directory },
      );
    const ordinary = load();
    expect(ordinary.exitCode, ordinary.stderr.toString()).toBe(0);
    expect(ordinary.stdout.toString().trim()).toBe(
      String(CI_GENERATED_FILES.length),
    );
    await writeFile(
      registry,
      `import "../packages/scripts/src/prepared-generated-sources";\n${source}`,
    );
    const misplaced = load();
    expect(misplaced.exitCode).not.toBe(0);
    expect(misplaced.stderr.toString()).toContain("prepared-generated-sources");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Guard A rejects an unregistered generated source and ignores ordinary comments", () => {
  const unknown = "packages/example/src/unlisted.ts";
  expect(
    isGeneratedCandidate(unknown, "// Generated by a script\nexport {};"),
  ).toBe(true);
  expect(isRegisteredGeneratedFile(unknown)).toBe(false);
  expect(
    isUnregisteredGeneratedFile(
      unknown,
      "// Generated by a script\nexport {};",
    ),
  ).toBe(true);
  expect(isGeneratedCandidate("packages/example/src/unlisted.gen.ts", "")).toBe(
    true,
  );
  expect(
    isGeneratedCandidate(
      unknown,
      "// The generated output is consumed elsewhere.\nexport {};",
    ),
  ).toBe(false);
  for (const header of [
    "// @generated\nexport {};",
    "/* DO NOT EDIT. */\nexport {};",
    "# Generated by a script\nvalue: true",
  ]) {
    expect(isGeneratedCandidate(unknown, header)).toBe(true);
  }
  for (const header of [
    "// The generated output is consumed elsewhere.",
    "// This is generated test data.",
    "// Do not edit the input by hand.",
    `${"// ordinary\n".repeat(10)}// Generated by a script`,
  ]) {
    expect(isGeneratedCandidate(unknown, header)).toBe(false);
  }
  expect(isRegisteredGeneratedFile("apps/web/src/routeTree.gen.ts")).toBe(true);
  expect(isUnregisteredGeneratedFile("apps/web/src/routeTree.gen.ts", "")).toBe(
    false,
  );
  expect(isRegisteredGeneratedFile("apps/desktop/src-tauri/Cargo.lock")).toBe(
    true,
  );
});

test("capability shard additions are registered and feed CLI generation", () => {
  const catalogShard = "packages/cli/capabilities/matters.list.json";
  const dispatchShard =
    "apps/api/src/mcp/generated/capability-dispatch/matters.list.ts";
  expect(isRegisteredGeneratedFile(catalogShard)).toBe(true);
  expect(isRegisteredGeneratedFile(dispatchShard)).toBe(true);
  expect(generatorsForFiles([catalogShard]).map(({ id }) => id)).toContain(
    "cli-registry",
  );
  expect(generatorsForFiles([catalogShard]).map(({ id }) => id)).toContain(
    "cli-runtime",
  );
  expect(generator("capability-catalog").outputs).not.toContain(
    "apps/api/src/mcp/generated/capability-dispatch.ts",
  );
});

test("derived runtime outputs have one owner and stay ignored when regenerated", () => {
  for (const id of [
    "capability-runtime",
    "cli-runtime",
    "mcp-app-contracts",
    "mcp-app-bundles",
  ] as const) {
    const outputs = generator(id).outputs;
    for (const output of outputs) {
      expect(
        GENERATORS.filter(({ outputs: ownerOutputs }) =>
          ownerOutputs.some((glob) => matchesGeneratedGlob(glob, output)),
        ).map((owner) => owner.id),
        output,
      ).toEqual([id]);
    }
    const ignored = Bun.spawnSync(
      ["git", "check-ignore", "--no-index", "--stdin"],
      {
        cwd: new URL("..", import.meta.url).pathname,
        stdin: new TextEncoder().encode(`${outputs.join("\n")}\n`),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(ignored.exitCode, id).toBe(0);
    expect(
      new TextDecoder().decode(ignored.stdout).trim().split("\n").toSorted(),
      id,
    ).toEqual([...outputs].toSorted());
  }
});

test("capability runtime cache manifests cover every file the producer writes", async () => {
  const fixture = await mkdtemp(nodePath.join(tmpdir(), "capability-outputs-"));
  try {
    const generated = nodePath.join(fixture, "apps/api/src/mcp/generated");
    const catalog = nodePath.join(fixture, "packages/cli/capabilities");
    await mkdir(nodePath.join(generated, "capability-dispatch"), {
      recursive: true,
    });
    await mkdir(catalog, { recursive: true });
    await writeFile(
      nodePath.join(catalog, "matters.list.json"),
      JSON.stringify({ id: "matters.list", featureId: "matters" }),
    );
    await mkdir(nodePath.join(fixture, "apps/api/src/handlers/workspaces"), {
      recursive: true,
    });
    await writeFile(
      nodePath.join(fixture, "apps/api/src/handlers/workspaces/list.ts"),
      "export default {};\n",
    );
    await generateCapabilityRuntime(pathToFileURL(`${fixture}/`));
    expect(ciGeneratedFiles(fixture)).toContain(
      "apps/api/src/mcp/generated/capability-dispatch/matters.list.ts",
    );
    expect(
      await readdir(nodePath.join(generated, "capability-dispatch")),
    ).toEqual(["matters.list.ts"]);
    const outputs = (await readdir(generated))
      .filter((file) => file.endsWith(".ts"))
      .map((file) => `src/mcp/generated/${file}`)
      .toSorted();
    expect(outputs.length).toBeGreaterThan(0);
    expect(outputs.map((file) => `apps/api/${file}`)).toEqual(
      [...CI_GENERATED_OUTPUTS.capabilityRuntime].toSorted(),
    );
    const config = v.parse(
      v.object({
        tasks: v.record(
          v.string(),
          v.looseObject({
            outputs: v.optional(v.array(v.string())),
            inputs: v.optional(v.array(v.string())),
            dependsOn: v.optional(v.array(v.string())),
          }),
        ),
      }),
      Bun.JSONC.parse(
        readFileSync(new URL("../turbo.json", import.meta.url), "utf-8"),
      ),
    );
    const assertOutputs = (tasks: typeof config.tasks) => {
      expect(tasks["@stll/api#generate:capability-runtime"]?.outputs).toContain(
        "src/mcp/generated/capability-dispatch/**",
      );
      expect(tasks["@stll/api#typecheck"]?.dependsOn).toContain(
        "typecheck:src",
      );
      expect(
        tasks["@stll/api#generate:capability-runtime"]?.outputs
          ?.filter((output) => !output.includes("*"))
          .toSorted(),
      ).toEqual(outputs);
      for (const output of outputs) {
        expect(tasks["@stll/api#typecheck:src"]?.dependsOn).toContain(
          "generate:capability-runtime",
        );
        expect(tasks["@stll/web#generate:api-types"]?.inputs).toContain(
          `!$TURBO_ROOT$/apps/api/${output}`,
        );
      }
    };
    assertOutputs(config.tasks);
    for (const output of outputs) {
      const mutated = structuredClone(config.tasks);
      const web = mutated["@stll/web#generate:api-types"];
      if (web?.inputs === undefined) {
        panic("Missing web API generation inputs");
      }
      const originalLength = web.inputs.length;
      web.inputs = web.inputs.filter(
        (input) => input !== `!$TURBO_ROOT$/apps/api/${output}`,
      );
      expect(web.inputs.length).toBe(originalLength - 1);
      expect(() => assertOutputs(mutated)).toThrow("toContain");
    }
    for (const task of ["@stll/api#generate:capability-runtime"]) {
      for (const output of outputs) {
        const mutated = structuredClone(config.tasks);
        const body = mutated[task];
        if (!body?.outputs) {
          panic(`Missing capability cache output fixture: ${task}`);
        }
        body.outputs = body.outputs.filter((file) => file !== output);
        expect(() => assertOutputs(mutated)).toThrow("expect(received)");
      }
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("Guard A ignores hand-written certificate and error fixtures", async () => {
  for (const name of [
    "self-signed-certificate",
    "test-pki",
    "legacy-error-fields",
  ]) {
    const file = `apps/api/src/tests/helpers/${name}.ts`;
    const header = await Bun.file(file).slice(0, 4096).text();
    expect(isGeneratedCandidate(file, header), file).toBe(false);
  }
});

test("the route generator pin matches the plugin's resolved generator", () => {
  expect(
    routeGeneratorVersionsMatch(
      "1.167.38",
      "1.167.38",
      "@tanstack/router-generator@1.167.38",
    ),
  ).toBe(true);
  expect(
    routeGeneratorVersionsMatch(
      "1.167.39",
      "1.167.38",
      "@tanstack/router-generator@1.167.38",
    ),
  ).toBe(false);
  expect(
    routeGeneratorVersionsMatch(
      undefined,
      "1.167.38",
      "@tanstack/router-generator@1.167.38",
    ),
  ).toBe(false);
});

test("the route generator guard rejects missing script and direct pin", async () => {
  const directory = await mkdtemp(
    nodePath.join(tmpdir(), "route-generator-guard-"),
  );
  const web = nodePath.join(directory, "apps/web");
  const root = pathToFileURL(`${directory}/`);
  try {
    await mkdir(nodePath.join(web, "scripts"), { recursive: true });
    await writeFile(
      nodePath.join(web, "package.json"),
      '{"devDependencies":{}}',
    );
    await writeFile(
      nodePath.join(directory, "bun.lock"),
      JSON.stringify({
        packages: {
          "@tanstack/router-generator": ["@tanstack/router-generator@1.167.38"],
          "@tanstack/router-plugin": [
            "@tanstack/router-plugin@1.168.40",
            "",
            { dependencies: { "@tanstack/router-generator": "1.167.38" } },
          ],
        },
      }),
    );
    const missingScript = await checkRouteGeneratorVersion(root).catch(
      (error: unknown) => error,
    );
    expect(missingScript).toHaveProperty(
      "message",
      "The route-tree generator script is missing",
    );
    await writeFile(
      nodePath.join(web, "scripts/generate-route-tree.ts"),
      "export {};\n",
    );
    const missingPin = await checkRouteGeneratorVersion(root).catch(
      (error: unknown) => error,
    );
    expect(missingPin).toHaveProperty(
      "message",
      "The direct router-generator pin is missing",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("visual sandbox regeneration follows its shared error metadata owner", () => {
  for (const file of [
    "packages/errors/src/fingerprint-fields.ts",
    "packages/errors/src/exception-cause-chain.ts",
    "apps/api/src/handlers/visual-sandbox/prepare.ts",
    "apps/api/src/handlers/visual-sandbox/sanitize.ts",
  ]) {
    expect(
      generatorsForFiles([file]).map(({ id }) => id),
      file,
    ).toContain("visual-sandbox-bundle");
  }
});

test("autofix selects only owners of changed inputs and preserves dependencies", () => {
  expect(
    generatorsForFiles([
      "packages/api-contract/src/document-version-upload.ts",
    ]).map(({ id }) => id),
  ).toContain("cli-registry");
  const requiredIds = [
    "capability-catalog",
    "capability-runtime",
    "cli-registry",
    "cli-runtime",
    "api-typecheck-projects",
  ] satisfies readonly (typeof GENERATORS)[number]["id"][];
  expect(
    generatorsForFiles(["apps/web/src/routes/law/index.tsx"]).map(
      ({ id }) => id,
    ),
  ).toEqual(["tailwind-class-cache", "module-ownership", "route-tree"]);
  // api-typecheck-projects declares the derived CLI and capability runtimes,
  // which a clean checkout lacks, so they are planned with it.
  expect(
    generatorsForFiles(["scripts/ownership/new-capability.ts"]).map(
      ({ id }) => id,
    ),
  ).toEqual([
    "capability-runtime",
    "cli-runtime",
    "api-typecheck-projects",
    "module-ownership",
  ]);
  expect(generatorsForFiles(["docs/unrelated.md"]).map(({ id }) => id)).toEqual(
    [],
  );
  for (const file of [
    "apps/api/src/lib/format.ts",
    "packages/agent-input/src/format.ts",
  ]) {
    const selected = new Set(generatorsForFiles([file]).map(({ id }) => id));
    for (const id of requiredIds) {
      expect(selected.has(id), `${file} selects ${id}`).toBe(true);
    }
  }
  const ordered = orderGenerators(
    generatorsForFiles(["apps/api/src/handlers/example.ts"]),
  );
  expect(
    ordered.findIndex(({ id }) => id === "capability-catalog"),
  ).toBeLessThan(ordered.findIndex(({ id }) => id === "capability-runtime"));
  expect(
    ordered.findIndex(({ id }) => id === "capability-runtime"),
  ).toBeLessThan(ordered.findIndex(({ id }) => id === "cli-registry"));
  expect(ordered.findIndex(({ id }) => id === "cli-registry")).toBeLessThan(
    ordered.findIndex(({ id }) => id === "cli-runtime"),
  );
});

test("autofix selection closes over generated outputs and ordering dependencies", () => {
  const tracked = new TextDecoder()
    .decode(Bun.spawnSync(["git", "ls-files", "-z"], { stdout: "pipe" }).stdout)
    .split("\0")
    .filter(Boolean);
  const changedPaths = [
    [
      "bunfig.toml",
      "capability-catalog",
      "capability-runtime",
      "cli-registry",
      "cli-runtime",
    ],
    [
      "packages/api-contract/src/mcp-tool.ts",
      "mcp-app-bundles",
      "capability-catalog",
    ],
  ] as const;
  for (const [file, ...required] of changedPaths) {
    const selected = generatorsForFiles([file]);
    const ids = new Set(selected.map(({ id }) => id));
    for (const id of required) {
      expect(ids.has(id), `${file} selects ${id}`).toBe(true);
    }
    for (const upstream of selected) {
      const generatedOutputFiles = tracked.filter((outputFile) =>
        upstream.outputs.some((output) =>
          matchesGeneratedGlob(output, outputFile),
        ),
      );
      for (const downstream of GENERATORS.filter(({ autofix }) => autofix)) {
        if (downstream.after.some((id) => id === upstream.id)) {
          expect(
            ids.has(downstream.id),
            `${upstream.id} feeds ${downstream.id}`,
          ).toBe(true);
        }
        const feedsDownstream = generatedOutputFiles.some((outputFile) =>
          downstream.inputs.some((input) =>
            matchesGeneratedGlob(input, outputFile),
          ),
        );
        if (feedsDownstream) {
          expect(
            ids.has(downstream.id),
            `${upstream.id} output feeds ${downstream.id}`,
          ).toBe(true);
        }
      }
    }
  }
});

test("the planned allowlist is exactly the selected committed output union", () => {
  for (const paths of [
    "bunfig.toml\n",
    "packages/api-contract/src/mcp-tool.ts\n",
    "docs/unrelated.md\n",
  ]) {
    const plan = Bun.spawnSync(["bun", "scripts/autofix-plan.ts", "plan"], {
      stdin: new TextEncoder().encode(paths),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(plan.exitCode).toBe(0);
    const values = Object.fromEntries(
      new TextDecoder()
        .decode(plan.stdout)
        .trim()
        .split("\n")
        .map((line) => line.split("=", 2)),
    );
    const selected = generatorsForFiles(paths.trim().split("\n"));
    expect(values["ids"]?.split(",").filter(Boolean).toSorted()).toEqual(
      selected.map(({ id }) => id).toSorted(),
    );
    expect(values["allowed"]?.split("|").filter(Boolean).toSorted()).toEqual(
      allowedOutputs(selected).toSorted(),
    );
  }
});

test("manifest paths and named guards resolve against tracked files and CI", async () => {
  const tracked = new TextDecoder()
    .decode(Bun.spawnSync(["git", "ls-files", "-z"], { stdout: "pipe" }).stdout)
    .split("\0")
    .filter(Boolean);
  // Local skill sources must affect the generation input contract, including a skill
  // added after the generator's other inputs were last reviewed.
  const instructions = generator("ai-instructions");
  const localSkills = tracked.filter((file) =>
    file.startsWith(".ai/local-skills/"),
  );
  expect(localSkills.length).toBeGreaterThan(0);
  for (const file of localSkills) {
    expect(
      instructions.inputs.some((glob) => matchesGeneratedGlob(glob, file)),
      `ai-instructions: ${file}`,
    ).toBe(true);
  }
  // Pooled checks are steps of their job, so resolve names through them.
  const workflow: unknown = Bun.YAML.parse(ci);
  const steps = new Set([
    ...[...ci.matchAll(/^\s+- name: (.+)$/gmu)].map((match) => match[1]),
    ...CHECK_POOL_JOBS.flatMap((job) =>
      workflowJobSteps(workflow, job).map(({ name }) => name),
    ),
  ]);
  for (const entry of GENERATORS) {
    for (const glob of entry.inputs) {
      expect(
        tracked.some((file) => matchesGeneratedGlob(glob, file)),
        `${entry.id}: ${glob}`,
      ).toBe(true);
    }
    for (const glob of entry.outputs) {
      const isTracked = tracked.some((file) =>
        matchesGeneratedGlob(glob, file),
      );
      switch (entry.outputKind) {
        case "committed":
          expect(isTracked, `${entry.id}: ${glob}`).toBe(true);
          break;
        case "derived": {
          expect(isTracked, `${entry.id}: ${glob} must stay untracked`).toBe(
            false,
          );
          const ignored = Bun.spawnSync(
            ["git", "check-ignore", "--no-index", "--", glob],
            { stdout: "pipe", stderr: "pipe" },
          );
          expect(ignored.exitCode, `${entry.id}: ${glob} must be ignored`).toBe(
            0,
          );
          expect(allowedOutputs([entry])).not.toContain(glob);
          break;
        }
        default:
          entry satisfies never;
      }
    }
    if ("checkedBy" in entry) {
      expect(
        steps.has(entry.checkedBy),
        `${entry.id}: ${entry.checkedBy}`,
      ).toBe(true);
    }
    expect(entry.outputs.every((glob) => !/[|\n]/u.test(glob))).toBe(true);
    const scriptFile = entry.write.find((part) => /\.(?:ts|sh)$/u.test(part));
    if (scriptFile) {
      expect(existsSync(scriptFile), `${entry.id}: ${scriptFile}`).toBe(true);
      continue;
    }
    const write: readonly string[] = entry.write;
    const filter = write.indexOf("--filter");
    const cwd = write.find((part) => part.startsWith("--cwd="));
    let packagePath = cwd?.replace("--cwd=", "") ?? ".";
    if (filter !== -1) {
      packagePath = (write[filter + 1] ?? "").replace("@stll/", "");
    }
    let root = packagePath;
    if (packagePath !== "." && !packagePath.includes("/")) {
      root =
        ["apps", "packages"]
          .map((dir) => `${dir}/${packagePath}`)
          .find((path) => existsSync(`${path}/package.json`)) ?? packagePath;
    }
    const packageJson = await Bun.file(`${root}/package.json`).json();
    const run = write.indexOf("run");
    const script = run !== -1 ? write[run + 1] : write[filter + 2];
    expect(script, `${entry.id} has a script`).toBeDefined();
    if (script === undefined) {
      continue;
    }
    expect(
      packageJson.scripts?.[script],
      `${entry.id}: ${script}`,
    ).toBeDefined();
  }
  for (const { glob } of GUARD_A_EXCLUSIONS) {
    expect(
      tracked.some((file) => matchesGeneratedGlob(glob, file)),
      glob,
    ).toBe(true);
  }
});

test("the plan alone never authorizes the ratchet baseline", () => {
  const selected = generatorsForFiles(["apps/web/src/example.ts"]);
  expect(allowedOutputs(selected)).not.toContain(
    "scripts/ratchet-baseline.json",
  );
});

test("autofix refuses an empty selected-generator handoff", () => {
  const run = Bun.spawnSync(["bun", "scripts/autofix-plan.ts", "allowed", ""], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.exitCode).toBe(1);
  expect(new TextDecoder().decode(run.stderr)).toContain(
    "Autofix plan has no selected generators",
  );
});

test("lint selection derives committed generated outputs from the manifest", () => {
  expect(isChangedLintPath("apps/web/src/routeTree.gen.ts")).toBe(false);
  expect(isChangedLintPath("packages/skills/src/blueprints.gen.ts")).toBe(
    false,
  );
  expect(isChangedLintPath("apps/web/src/routes/new.gen.ts")).toBe(true);
  expect(isChangedLintPath("apps/web/public/prepaint-init.js")).toBe(true);
  expect(
    isChangedLintPath(
      "apps/api/src/lib/legal-search/morphology/snowball/__fixtures__/vocabulary.ts",
    ),
  ).toBe(true);
});

const ci = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf-8",
);
const ciGeneratedSteps = workflowJobSteps(
  Bun.YAML.parse(ci),
  "ci-checks-generated",
);
const ciGeneratedStepRun = (name: string): string => {
  const run = workflowStepByName(ciGeneratedSteps, name)["run"];
  if (typeof run !== "string") {
    panic(`CI step ${name} has no run command`);
  }
  return run;
};

const scopedOutput = (file: string, output: ScopeOutput) =>
  computeChangedFileScope(
    {
      changedFiles: [file],
      comparisonBase: "base",
      scopeUnknown: false,
      eventName: "pull_request",
      suiteDepth: "fast",
      heavyOnly: false,
      prTitle: "",
    },
    {
      ...DEFAULT_DETECTORS,
      packageChecks: () => true,
      landingBuild: () => false,
      landingDeploy: () => false,
      desktopBrowser: () => false,
    },
  )[output];

test("route-tree CI scope covers every manifest input and output", () => {
  const routeTree = generator("route-tree");
  const paths = [...routeTree.inputs, ...routeTree.outputs].map((glob) =>
    glob.replace(/\/\*\*$/u, "/*"),
  );
  expect(paths.toSorted()).toEqual([...ROUTE_TREE_INPUTS].toSorted());
});

test("CI rate snapshot scope stays pinned to the manifest", () => {
  const inputs = generator("model-rates").inputs.map((glob) =>
    glob.replace(/\/\*\*$/u, "/*"),
  );
  expect(inputs.toSorted()).toEqual([...MODEL_CATALOG_DRIFT_INPUTS].toSorted());
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const generationInputs = (name: string) => {
  const config: unknown = Bun.JSONC.parse(
    readFileSync(new URL("../turbo.json", import.meta.url), "utf-8"),
  );
  if (!isRecord(config) || !isRecord(config["tasks"])) {
    panic("Turbo configuration has no tasks");
  }
  const task = config["tasks"][`@stll/web#${name}`];
  if (!isRecord(task) || !Array.isArray(task["inputs"])) {
    panic(`Missing generation task inputs for ${name}`);
  }
  return task["inputs"]
    .map((input: unknown) => {
      if (typeof input !== "string") {
        panic("Generation task input must be a glob");
      }
      return input;
    })
    .filter((input) => !input.startsWith("!"));
};

test("CI determinism selectors cover the cached generators' input contracts", () => {
  for (const [name, output] of [
    ["generate:api-types", "web_api_types_required"],
    ["generate:route-tree", "route_tree_required"],
  ] as const) {
    // Turbo accepts brace sets; each alternative must be covered on its own.
    const expandBraces = (glob: string): string[] => {
      const match = /\{([^{}]+)\}/u.exec(glob);
      if (match === null) {
        return [glob];
      }
      const [set, alternatives = ""] = match;
      return alternatives
        .split(",")
        .flatMap((alternative) =>
          expandBraces(
            `${glob.slice(0, match.index)}${alternative}${glob.slice(match.index + set.length)}`,
          ),
        );
    };
    for (const glob of generationInputs(name).flatMap(expandBraces)) {
      const rooted = glob.startsWith("$TURBO_ROOT$/")
        ? glob.replace("$TURBO_ROOT$/", "")
        : `apps/web/${glob}`;
      // Shell case * crosses directory separators, unlike Bun.Glob's *.
      const sample = rooted
        .replace(/\*\*/gu, "nested")
        .replace(/\*/gu, "fixture")
        .replace(/\?/gu, "x");
      expect(
        scopedOutput(sample, output),
        `${name} CI selector covers ${rooted}`,
      ).toBe("true");
    }
  }
});

test.each([
  "apps/api/src/mcp/web-handoff-link-contract.ts",
  "apps/api/src/mcp/write-result-omission.ts",
])("app contracts follow their advertised output owner %s", (file) => {
  expect(generatorsForFiles([file]).map(({ id }) => id)).toContain(
    "mcp-app-contracts",
  );
});

test("CI diff path guards stay pinned to manifest outputs", () => {
  const cli = ciGeneratedStepRun(
    "CLI sharded registry and derived runtime guard",
  );
  const diff = cli.split("git diff --exit-code -- \\\n")[1];
  expect(diff).toBeDefined();
  const paths: string[] = [];
  for (const line of (diff ?? "").split("\n")) {
    const argument = line.trim();
    paths.push(argument.replace(/ \\$/u, ""));
    if (!argument.endsWith("\\")) {
      break;
    }
  }
  expect(paths.toSorted()).toEqual(
    generator("cli-registry")
      .outputs.map((glob) => glob.replace(/\/\*\*$/u, ""))
      .toSorted(),
  );
  for (const id of ["mcp-app-contracts", "mcp-app-bundles"] as const) {
    expect(generator(id).outputKind).toBe("derived");
    expect(generator(id).check).toEqual([
      "bun",
      "scripts/check-mcp-generated-tracking.ts",
    ]);
  }
  const bundle = ciGeneratedStepRun("MCP app derived outputs guard");
  // Derived outputs are untracked, so a diff would pass on anything: the
  // guard instead requires every declared output to exist after the build
  // and runs the tracking check.
  const declared = (bundle.split("outputs=(\n")[1] ?? "")
    .split("\n)")[0]
    ?.split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  expect(declared?.toSorted()).toEqual(
    [
      ...generator("mcp-app-contracts").outputs,
      ...generator("mcp-app-bundles").outputs,
    ].toSorted(),
  );
  expect(bundle).not.toContain("git diff --exit-code");
  expect(bundle).toContain('test -s "$output"');
  expect(bundle).toContain("bun scripts/check-mcp-generated-tracking.ts");
  const preparation = readFileSync(
    new URL("ci-generated-sources.ts", import.meta.url),
    "utf-8",
  );
  expect(preparation).toContain('from "./check-mcp-generated-tracking"');
  expect(preparation).toContain("checkMcpGeneratedTracking(");
});

test("route tree has one derived owner and a cache producer for every consumer", () => {
  const owner = generator("route-tree");
  expect(owner.outputKind).toBe("derived");
  const config = v.parse(
    v.object({
      tasks: v.record(
        v.string(),
        v.looseObject({
          dependsOn: v.optional(v.array(v.string())),
          outputs: v.optional(v.array(v.string())),
        }),
      ),
    }),
    Bun.JSONC.parse(
      readFileSync(new URL("../turbo.json", import.meta.url), "utf-8"),
    ),
  );
  const output = "apps/web/src/routeTree.gen.ts";
  expect(
    GENERATORS.filter(({ outputs }) =>
      outputs.some((file) => file === output),
    ).map(({ id }) => id),
  ).toEqual([owner.id]);
  const ignored = Bun.spawnSync(["git", "check-ignore", "--no-index", output]);
  expect(ignored.exitCode).toBe(0);
  const producer = config.tasks["@stll/web#generate:route-tree"];
  expect(producer?.outputs).toEqual([
    "src/routeTree.gen.ts",
    "src/route-templates.gen.ts",
  ]);
  expect(
    generationInputs("generate:route-tree")
      .map((input) =>
        input.startsWith("$TURBO_ROOT$/")
          ? input.replace("$TURBO_ROOT$/", "")
          : `apps/web/${input}`,
      )
      .toSorted(),
  ).toEqual([...owner.inputs].toSorted());
  for (const name of [
    "typecheck",
    "lint",
    "lint:fix",
    "test",
    "test:property",
    "build",
    "dev",
  ]) {
    expect(config.tasks[`@stll/web#${name}`]?.dependsOn, name).toContain(
      "generate:route-tree",
    );
  }
});

test("web messages have one derived owner and are generated wherever the route tree is", () => {
  const owner = generator("i18n-messages-web");
  expect(owner.outputKind).toBe("derived");
  const output = "apps/web/src/i18n/langs/messages.gen.ts";
  expect(owner.outputs).toEqual([output]);
  expect(
    GENERATORS.filter(({ outputs }) =>
      outputs.some((file) => file === output),
    ).map(({ id }) => id),
  ).toEqual([owner.id]);
  const ignored = Bun.spawnSync(["git", "check-ignore", "--no-index", output]);
  expect(ignored.exitCode).toBe(0);
  const config = v.parse(
    v.object({
      tasks: v.record(
        v.string(),
        v.looseObject({
          dependsOn: v.optional(v.array(v.string())),
          outputs: v.optional(v.array(v.string())),
        }),
      ),
    }),
    Bun.JSONC.parse(
      readFileSync(new URL("../turbo.json", import.meta.url), "utf-8"),
    ),
  );
  expect(config.tasks["@stll/web#generate:messages"]?.outputs).toEqual([
    "src/i18n/langs/messages.gen.ts",
  ]);
  expect(
    generationInputs("generate:messages")
      .map((input) =>
        input.startsWith("$TURBO_ROOT$/")
          ? input.replace("$TURBO_ROOT$/", "")
          : `apps/web/${input}`,
      )
      .toSorted(),
  ).toEqual([...owner.inputs].toSorted());
  // Every task that needs the derived route tree reads the web sources, and
  // those import the message declarations too. API type generation reads the
  // routes only.
  for (const [name, task] of Object.entries(config.tasks)) {
    const dependsOn = task.dependsOn ?? [];
    if (
      dependsOn.includes("generate:route-tree") &&
      name !== "@stll/web#generate:api-types"
    ) {
      expect(dependsOn, name).toContain("generate:messages");
    }
    if (dependsOn.includes("@stll/web#generate:route-tree")) {
      expect(dependsOn, name).toContain("@stll/web#generate:messages");
    }
  }
  const manifests = v.parse(
    v.object({ scripts: v.record(v.string(), v.string()) }),
    JSON.parse(
      readFileSync(
        new URL("../apps/web/package.json", import.meta.url),
        "utf-8",
      ),
    ),
  );
  // Outside Turbo, scripts generate both through one producer step, a shape
  // the Docker source closure and the shell parsers recognise.
  expect(manifests.scripts["generate:web-sources"]).toBe(
    "bun run generate:route-tree && bun run generate:messages",
  );
  for (const [name, script] of Object.entries(manifests.scripts)) {
    if (name === "generate:web-sources") {
      continue;
    }
    expect(script, name).not.toContain("bun run generate:route-tree");
    // The fallback is either this producer step or the root generate, which
    // includes generate:messages (checked below).
    if (script.includes('[ -n "$TURBO_HASH" ]')) {
      expect(
        script.includes(
          '([ -n "$TURBO_HASH" ] || bun run generate:web-sources)',
        ) ||
          /\[ -n "\$TURBO_HASH" \] \|\| bun run (?:--cwd \.\.\/\.\. )?generate\)/u.test(
            script,
          ),
        name,
      ).toBe(true);
    }
  }
  const root = v.parse(
    v.object({ scripts: v.object({ generate: v.string() }) }),
    JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
    ),
  );
  expect(root.scripts.generate).toContain("generate:messages");
});

// Runs in a copy of the tracked files the checks read, never by deleting the
// checkout's declarations: other test files read them concurrently.
// Measured p95 is 19.8 s; this test must run the real web catalog checker in that copy.
test("web catalog checks pass without the derived message declarations", async () => {
  const repo = new URL("..", import.meta.url).pathname;
  const tracked = Bun.spawnSync(
    [
      "git",
      "ls-files",
      "-z",
      "--",
      "apps/web/package.json",
      "apps/web/src",
      "apps/web/scripts",
      "apps/web/public/prepaint-init.js",
      "packages/ai-catalog/src",
    ],
    { cwd: repo, stdout: "pipe", stderr: "pipe" },
  );
  expect(tracked.exitCode).toBe(0);
  const files = tracked.stdout.toString().split("\0").filter(Boolean);
  expect(files).not.toContain("apps/web/src/i18n/langs/messages.gen.ts");
  const copy = await mkdtemp(nodePath.join(tmpdir(), "web-catalog-check-"));
  try {
    for (const file of files) {
      await mkdir(nodePath.dirname(nodePath.join(copy, file)), {
        recursive: true,
      });
      await writeFile(
        nodePath.join(copy, file),
        await Bun.file(nodePath.join(repo, file)).bytes(),
      );
    }
    // Code and dependencies are shared read-only with the checkout.
    for (const link of [
      "node_modules",
      "apps/web/node_modules",
      "packages/scripts",
    ]) {
      if (existsSync(nodePath.join(repo, link))) {
        await symlink(nodePath.join(repo, link), nodePath.join(copy, link));
      }
    }
    const check = Bun.spawnSync(["bun", "run", "i18n:check"], {
      cwd: nodePath.join(copy, "apps/web"),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(new TextDecoder().decode(check.stderr)).not.toContain("error");
    expect(check.exitCode).toBe(0);
    expect(
      existsSync(
        nodePath.join(copy, "apps/web/src/i18n/langs/messages.gen.ts"),
      ),
    ).toBe(false);
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
}, 40_000);

test("long optional runs accept dispatch only", () => {
  for (const file of [
    "bundle-size-nightly.yml",
    "nightly-property-test.yml",
    "nightly-typecheck.yml",
  ]) {
    const workflow = v.parse(
      v.looseObject({ on: v.record(v.string(), v.unknown()) }),
      Bun.YAML.parse(
        readFileSync(
          new URL(`../.github/workflows/${file}`, import.meta.url),
          "utf-8",
        ),
      ),
    );
    expect(Object.keys(workflow.on), file).toEqual(["workflow_dispatch"]);
  }
});

test("the fresh-export proof runs alone on dispatch", () => {
  const workflow = v.parse(
    v.object({ jobs: v.record(v.string(), v.looseObject({ if: v.string() })) }),
    Bun.YAML.parse(
      readFileSync(
        new URL("../.github/workflows/nightly-typecheck.yml", import.meta.url),
        "utf-8",
      ),
    ),
  );
  expect(workflow.jobs["fresh-web-sources"]?.if).toBe(
    `\${{ inputs.fresh-web }}`,
  );
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name === "fresh-web-sources") {
      continue;
    }
    expect(job.if, name).toBe(`\${{ !inputs.fresh-web }}`);
  }
});

test("catalog upstream inputs have one scheduled producer and an offline check", () => {
  const owner = generator("model-catalog-inputs");
  expect(owner.write).toEqual([
    "bun",
    "--filter",
    "@stll/ai-catalog",
    "gen:rates",
    "--refresh",
  ]);
  expect(owner.check).toEqual([
    "bun",
    "--filter",
    "@stll/ai-catalog",
    "gen:rates",
    "--check",
  ]);
  expect(owner.autofix).toBe(false);
  for (const file of [
    "packages/ai-catalog/upstream/models.dev.gen.json",
    "packages/ai-catalog/upstream/openrouter.gen.json",
  ]) {
    expect(isRegisteredGeneratedFile(file)).toBe(true);
    expect(
      GENERATORS.filter(({ outputs }) =>
        outputs.some((glob) => matchesGeneratedGlob(glob, file)),
      ).map(({ id }) => id),
    ).toEqual([owner.id]);
  }
});

test("API compiler input regeneration uses the restricted autofix output contract", () => {
  const owner =
    GENERATORS.find((entry) => entry.id === "api-typecheck-projects") ??
    panic("Missing API compiler input generator");
  const outputs = [
    "apps/api/tsconfig.declarations.json",
    "apps/api/tsconfig.src.json",
    "apps/api/tsconfig.tests.json",
    "turbo.json",
  ];
  expect(owner.autofix).toBe(true);
  expect(allowedOutputs([owner]).toSorted()).toEqual(outputs.toSorted());
  expect(owner.checkedBy).toBe("Typecheck coverage");
  for (const file of [
    "apps/api/src/new.ts",
    "packages/shared/src/new.ts",
    "scripts/status-transition.ts",
    "apps/runner/tsconfig.json",
    "bun.lock",
    "patches/example.patch",
    ...outputs,
  ]) {
    expect(
      generatorsForFiles([file]).map(({ id }) => id),
      file,
    ).toContain(owner.id);
  }
  const commands = API_TYPECHECK_REGENERATION_COMMANDS.map((command) =>
    command.join(" "),
  );
  expect(commands).toEqual([
    "bun --cwd=packages/cli run codegen:runtime",
    "bun --cwd=apps/api run generate:capability-runtime",
    "bun --cwd=apps/api run generate:typecheck-declarations --write-surface",
    "bun packages/scripts/src/api-typecheck-partition.ts --write",
    "bun packages/scripts/src/api-typecheck-partition.ts --resolved",
  ]);
  const selected = orderGenerators(generatorsForFiles(["apps/api/src/new.ts"]));
  const ids = selected.map(({ id }) => id);
  for (const prerequisite of owner.after) {
    expect(ids).toContain(prerequisite);
    expect(ids.indexOf(prerequisite)).toBeLessThan(ids.indexOf(owner.id));
  }
});

test("cloud setup has one generator owner and checks shared policy output", () => {
  const owners = GENERATORS.filter(({ outputs }) =>
    outputs.some((glob) =>
      matchesGeneratedGlob(glob, ".agents/cloud-setup.sh"),
    ),
  );
  expect(owners).toHaveLength(1);
  expect(owners.at(0)).toMatchObject({
    id: "cloud-setup",
    inputs: [
      "bunfig.toml",
      ".prettierrc.yml",
      "packages/portable-path/src/index.ts",
      "packages/scripts/src/child-exit-status.ts",
      "packages/scripts/src/generated-artifact-format.ts",
      "stll-toolchain.json",
      ".node-version",
      "package.json",
      "bun.lock",
      "scripts/generate-cloud-setup.ts",
      "scripts/generated-artifacts.ts",
    ],
    write: ["bun", "scripts/generate-cloud-setup.ts", "--write"],
    check: ["bun", "scripts/generate-cloud-setup.ts"],
    autofix: true,
  });
  expect(
    isUnregisteredGeneratedFile(
      ".agents/cloud-setup.sh",
      "# Generated by stll-cloud-setup.",
    ),
  ).toBe(false);
});

// A plan runs from a clean checkout, where no derived output exists: every
// derived output a planned generator reads must come from a generator planned
// before it, whichever file started the plan.
// timeout: exhaustively checking every declared transitive input is CPU-bound.
test("every plan builds the derived outputs its generators read before running them", () => {
  const witness = (glob: string) =>
    glob.replaceAll("**", "example/generated.ts").replaceAll("*", "example");
  const problems: string[] = [];
  for (const start of GENERATORS) {
    for (const glob of [...start.inputs, ...start.outputs]) {
      const plan = orderGenerators(generatorsForFiles([witness(glob)]));
      const position = new Map(plan.map(({ id }, index) => [id, index]));
      for (const planned of plan) {
        for (const prerequisite of derivedPrerequisites(planned)) {
          const at = position.get(prerequisite.id);
          if (at === undefined || at > (position.get(planned.id) ?? -1)) {
            problems.push(
              `${glob}: ${planned.id} reads ${prerequisite.id} ${at === undefined ? "unplanned" : "built later"}`,
            );
          }
        }
        if (!planned.autofix) {
          problems.push(
            `${glob}: ${planned.id} is planned but not autofix-eligible`,
          );
        }
      }
    }
  }
  expect([...new Set(problems)]).toEqual([]);
}, 10_000);

// Building a prerequisite first is useless if the run then skips it: a derived
// generator's check guards tracking, so it passes on a clean checkout that
// lacks the outputs. Every check here passes; only committed outputs may skip.
test("a run writes every derived generator even when its check passes", () => {
  const spawned: string[] = [];
  const failed = runGenerators(
    orderGenerators(GENERATORS.filter(({ autofix }) => autofix)),
    (command) => {
      spawned.push(command.join(" "));
      return 0;
    },
    () => undefined,
  );
  expect(failed).toBeNull();
  for (const owner of GENERATORS.filter(({ autofix }) => autofix)) {
    expect(spawned.includes(owner.write.join(" ")), owner.id).toBe(
      owner.outputKind === "derived" || owner.check === null,
    );
  }
  expect(
    runGenerators(
      [generator("mcp-app-bundles")],
      () => 1,
      () => undefined,
    )?.id,
  ).toBe("mcp-app-bundles");
});

test("a CLI registry change plans the MCP app bundles it reads", () => {
  const ids = orderGenerators(
    generatorsForFiles(["packages/cli/src/generated/registry-snapshot.json"]),
  ).map(({ id }) => id);
  for (const prerequisite of [
    "mcp-app-contracts",
    "mcp-app-bundles",
    "capability-runtime",
  ]) {
    expect(ids).toContain(prerequisite);
    expect(ids.indexOf(prerequisite)).toBeLessThan(ids.indexOf("cli-registry"));
  }
});
