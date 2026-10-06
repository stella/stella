import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import {
  CLI_CONTRACT_SURFACE_PATHS,
  canonicalJson,
  findSurfaceDrift,
  readHeadSurface,
  readPublishedPackageSurface,
  type CliContractSurface,
  type CliContractSurfacePart,
} from "./check-cli-release-coupling";
import { GENERATORS, type Generator } from "./generated-files";
import {
  findUnbuildableGeneratedImports,
  formatGeneratedImportViolation,
  generatorPackageScript,
  packScriptClosure,
  runTargets,
  specifierCandidates,
} from "./generated-imports";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CLI_DIRECTORY = "packages/cli";
const COMMAND_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 600_000;
const RUNTIME_SOURCES = [
  "src/generated/route-map.ts",
  "src/generated/tool-annotations.ts",
] as const;
// Everything the CLI's own scripts read. Dependencies, workspace packages
// included, resolve through the linked node_modules of the real checkout.
const EXPORTED_PATHS = [
  "package.json",
  CLI_DIRECTORY,
  "packages/scripts",
  // Historical base revisions still import the root metadata.
  "scripts/generated-files.ts",
];
// The exported tree is parameterized; bind its source scope to the same
// export inventory so unresolved scans retain named package checks.
export const CI_MARKDOWN_READER_INPUTS = EXPORTED_PATHS;

const RUNTIME_GENERATOR =
  GENERATORS.find(({ id }) => id === "cli-runtime") ??
  panic("the generator manifest has no cli-runtime entry");

const run = (args: readonly [string, ...string[]], root: string): string => {
  const [command, ...parameters] = args;
  const childEnv = { ...process.env };
  if (root !== REPO_ROOT) {
    delete childEnv["CI_GENERATED_SOURCES_MANIFEST"];
  }
  const result = spawnSync(command, parameters, {
    cwd: root,
    env: childEnv,
    encoding: "utf-8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  expect(result.error, args.join(" ")).toBeUndefined();
  expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(0);
  return result.stdout;
};

const missingPreparationImports = (exportedPaths: readonly string[]) => {
  const owner = "packages/scripts/src/prepared-generated-sources.ts";
  const source = readFileSync(path.join(REPO_ROOT, owner), "utf-8");
  return [...source.matchAll(/from\s+["'](\.[^"']+)["']/gu)]
    .map((match) =>
      path.posix.normalize(
        path.posix.join(
          path.posix.dirname(owner),
          `${v.parse(v.string(), match.at(1))}.ts`,
        ),
      ),
    )
    .filter(
      (file) =>
        !exportedPaths.some(
          (exported) => file === exported || file.startsWith(`${exported}/`),
        ),
    );
};

test("fresh CLI export includes preparation metadata imports", () => {
  expect(missingPreparationImports(EXPORTED_PATHS)).toEqual([]);
  expect(
    missingPreparationImports(
      EXPORTED_PATHS.filter((file) => file !== "scripts/generated-files.ts"),
    ),
  ).toEqual([]);
  expect(
    missingPreparationImports(
      EXPORTED_PATHS.filter((file) => file !== "packages/scripts"),
    ),
  ).toContain("packages/scripts/src/generated-files.ts");
});

const Sha = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u));
const MergeGroupEvent = v.object({
  merge_group: v.object({ base_sha: Sha }),
});
const PullRequestEvent = v.object({
  pull_request: v.object({ base: v.object({ sha: Sha }) }),
});

/**
 * The commit a CI event compares against: the merge group's own base, which
 * may trail `origin/main` by several queued commits, or the pull request's
 * base. Other events have none and compare against the merge base.
 */
const eventBaseRevision = (
  eventName: string | undefined,
  readPayload: () => unknown,
): string | undefined => {
  if (eventName === "merge_group") {
    return v.parse(MergeGroupEvent, readPayload()).merge_group.base_sha;
  }
  if (eventName === "pull_request") {
    return v.parse(PullRequestEvent, readPayload()).pull_request.base.sha;
  }
  return undefined;
};

const baseRevision = (): string =>
  eventBaseRevision(process.env["GITHUB_EVENT_NAME"], () =>
    JSON.parse(
      readFileSync(
        process.env["GITHUB_EVENT_PATH"] ??
          panic("GITHUB_EVENT_PATH is not set for a CI event"),
        "utf-8",
      ),
    ),
  ) ?? run(["git", "merge-base", "origin/main", "HEAD"], REPO_ROOT).trim();

type Tree = {
  readonly root: string;
  readonly revision: string;
};

/**
 * Extract a clean tree of one exact revision. `git archive` runs in the real
 * checkout, where a partial clone fetches any blob it lacks from its promisor
 * remote; a local clone of a partial clone cannot, and then compiles against
 * whatever blobs earlier steps happened to fetch. Builds write only inside the
 * export: dependencies are read through a symlink.
 */
const exportRevision = (root: string, revision: string): Tree => {
  const archive = `${root}.tar`;
  run(
    [
      "git",
      "archive",
      "--format=tar",
      `--output=${archive}`,
      revision,
      "--",
      ...EXPORTED_PATHS,
    ],
    REPO_ROOT,
  );
  mkdirSync(root);
  run(["tar", "-xf", archive, "-C", root], REPO_ROOT);
  rmSync(archive);
  symlinkSync(
    path.join(REPO_ROOT, "node_modules"),
    path.join(root, "node_modules"),
    "dir",
  );
  return { root, revision };
};

const trackedCliSources = ({ revision }: Tree): string[] =>
  run(
    [
      "git",
      "ls-tree",
      "-r",
      "-z",
      "--name-only",
      revision,
      "--",
      CLI_DIRECTORY,
    ],
    REPO_ROOT,
  )
    .split("\0")
    .filter(Boolean)
    .map((file) => file.slice(CLI_DIRECTORY.length + 1));

const changedBetween = (
  base: Tree,
  head: Tree,
  paths: readonly string[],
): string[] =>
  run(
    [
      "git",
      "diff",
      "--name-only",
      base.revision,
      head.revision,
      "--",
      ...paths,
    ],
    REPO_ROOT,
  )
    .split("\n")
    .filter(Boolean);

const packedFiles = ({ root }: Tree): string[] => {
  // Prepack must regenerate missing runtime sources before its normal build.
  const packed: unknown = JSON.parse(
    run(
      [
        "npm",
        "pack",
        "--dry-run",
        "--json",
        "--foreground-scripts=false",
        "--ignore-scripts=false",
      ],
      path.join(root, CLI_DIRECTORY),
    ),
  );
  if (!Array.isArray(packed) || packed.length !== 1) {
    throw new TypeError("npm pack must report exactly one package");
  }
  const packageEntry: unknown = packed.at(0);
  if (
    typeof packageEntry !== "object" ||
    packageEntry === null ||
    !("files" in packageEntry) ||
    !Array.isArray(packageEntry.files)
  ) {
    throw new TypeError("npm pack must report its complete files list");
  }
  return packageEntry.files
    .map((entry: unknown) => {
      if (
        typeof entry !== "object" ||
        entry === null ||
        !("path" in entry) ||
        typeof entry.path !== "string"
      ) {
        throw new TypeError("npm pack files must contain string paths");
      }
      return entry.path;
    })
    .toSorted();
};

/** `addedSources` are files a step added on top of the exported revision. */
const expectedPackedFiles = (
  tree: Tree,
  addedSources: readonly string[] = [],
): string[] => {
  const directory = path.join(tree.root, CLI_DIRECTORY);
  const manifest = v.parse(
    v.object({ files: v.array(v.string()) }),
    JSON.parse(readFileSync(path.join(directory, "package.json"), "utf-8")),
  );
  expect(manifest.files).toContain("skills");
  const ownedSources = new Set([
    ...trackedCliSources(tree),
    ...addedSources,
    ...RUNTIME_SOURCES,
  ]);
  // Ask the actual compiler which files this build emits; module additions
  // need no mirrored source/dist list in the packaging acceptance test.
  const emitted = run(
    [
      process.execPath,
      "../../packages/scripts/src/tsc-native.ts",
      "-p",
      "tsconfig.build.json",
      "--listEmittedFiles",
    ],
    directory,
  )
    .split("\n")
    .filter((line) => line.startsWith("TSFILE: "))
    .map((line) =>
      path.relative(directory, line.slice("TSFILE: ".length).trim()),
    );
  for (const file of emitted) {
    const source = file
      .replace(/^dist\//u, "src/")
      .replace(/\.(?:d\.ts|js(?:\.map)?)$/u, ".ts");
    expect(ownedSources.has(source), `Unowned compiler output: ${file}`).toBe(
      true,
    );
  }
  // Build-copied data must also have a tracked source counterpart.
  const assets = [
    ...new Bun.Glob("dist/**/*.json").scanSync({ cwd: directory }),
  ];
  for (const file of assets) {
    expect(
      ownedSources.has(file.replace(/^dist\//u, "src/")),
      `Unowned build asset: ${file}`,
    ).toBe(true);
  }
  const candidates = new Set([...ownedSources, ...emitted, ...assets]);
  const selected = [...candidates].filter((file) =>
    manifest.files.some(
      (entry) =>
        file === entry ||
        file.startsWith(`${entry}/`) ||
        new Bun.Glob(entry).match(file),
    ),
  );
  return [...new Set(["package.json", ...selected])].toSorted();
};

type ReadSurfaceOptions = {
  readonly tree: Tree;
  readonly layout: "source" | "published";
};

const readSurface = ({
  tree,
  layout,
}: ReadSurfaceOptions): CliContractSurface => {
  const directory = path.join(tree.root, CLI_DIRECTORY);
  // Both readers assemble the catalog from shards, or a pre-cutover monolith.
  if (layout === "published") {
    return readPublishedPackageSurface(directory);
  }
  if (existsSync(path.join(directory, "capabilities"))) {
    return readHeadSurface(tree.root);
  }
  const read = (part: CliContractSurfacePart): string =>
    readFileSync(path.join(directory, part), "utf-8");
  return {
    "capability-catalog.json": read("capability-catalog.json"),
    "src/generated/registry-snapshot.json": read(
      "src/generated/registry-snapshot.json",
    ),
    "src/generated/api-contract.ts": read("src/generated/api-contract.ts"),
    "src/generated/mcp-contract.ts": read("src/generated/mcp-contract.ts"),
  } as const satisfies CliContractSurface;
};

const readBuiltRuntime = ({ root }: Tree): string =>
  canonicalJson(
    JSON.parse(
      run(
        [
          "node",
          "--input-type=module",
          "--eval",
          'import { generatedRouteMap } from "./dist/generated/route-map.js"; import { generatedToolAnnotations } from "./dist/generated/tool-annotations.js"; process.stdout.write(JSON.stringify({ routes: generatedRouteMap, annotations: generatedToolAnnotations }));',
        ],
        path.join(root, CLI_DIRECTORY),
      ),
    ),
  );

// Exactly the revision's tracked files: no checkout hook can link `.env`
// files or anything else into the tree that is packed.
const exportedFiles = ({ root }: Tree): string[] =>
  [...new Bun.Glob("**").scanSync({ cwd: root, dot: true })]
    .filter((file) => file !== "node_modules")
    .toSorted();

const revisionFiles = ({ revision }: Tree): string[] =>
  run(
    [
      "git",
      "ls-tree",
      "-r",
      "-z",
      "--name-only",
      revision,
      "--",
      ...EXPORTED_PATHS,
    ],
    REPO_ROOT,
  )
    .split("\0")
    .filter(Boolean)
    .toSorted();

describe("comparison base", () => {
  const payload = (value: unknown) => () => value;
  const sha = "a".repeat(40);

  test("a merge group compares against its own base, not the branch tip", () => {
    expect(
      eventBaseRevision(
        "merge_group",
        payload({ merge_group: { base_sha: sha, head_sha: "b".repeat(40) } }),
      ),
    ).toBe(sha);
  });

  test("a pull request compares against its base commit", () => {
    expect(
      eventBaseRevision(
        "pull_request",
        payload({ pull_request: { base: { sha }, head: { sha: "c" } } }),
      ),
    ).toBe(sha);
  });

  test("other events fall back without reading a payload", () => {
    for (const event of [undefined, "workflow_dispatch", "push"]) {
      expect(
        eventBaseRevision(event, () => panic("payload must not be read")),
      ).toBeUndefined();
    }
  });

  test("a malformed event payload fails instead of choosing another base", () => {
    expect(() =>
      eventBaseRevision("merge_group", payload({ merge_group: {} })),
    ).toThrow(v.ValiError);
    expect(() =>
      eventBaseRevision(
        "pull_request",
        payload({ pull_request: { base: { sha: "main" } } }),
      ),
    ).toThrow(v.ValiError);
  });
});

describe("generated imports", () => {
  const derived = {
    id: "probe-runtime",
    outputKind: "derived",
    outputs: ["packages/probe/src/generated/runtime.ts"],
    inputs: [],
    write: ["bun", "--cwd=packages/probe", "run", "codegen:runtime"],
    check: null,
    unchecked: "fixture",
    autofix: false,
    after: [],
  } as const satisfies Generator;
  const committed = {
    ...derived,
    id: "probe-committed",
    outputKind: "committed",
    outputs: ["packages/probe/src/contract.gen.ts"],
    write: ["bun", "scripts/probe.ts"],
  } as const satisfies Generator;
  const importer = "packages/probe/src/index.ts";
  const scan = ({
    source,
    tracked = [],
    scripts = {
      prepack: "bun run build",
      build: "bun run codegen:runtime && tsc",
      "codegen:runtime": "bun run src/codegen.ts",
    },
  }: {
    readonly source: string;
    readonly tracked?: readonly string[];
    readonly scripts?: Record<string, string>;
  }) =>
    findUnbuildableGeneratedImports({
      trackedFiles: ["packages/probe/package.json", importer, ...tracked],
      readSource: (file) => (file === importer ? source : ""),
      readScripts: (directory) => {
        expect(directory).toBe("packages/probe");
        return scripts;
      },
      generators: [derived, committed],
    });

  test("a tracked generated module is buildable", () => {
    expect(
      scan({
        source: 'import { a } from "./generated/contract.js";',
        tracked: ["packages/probe/src/generated/contract.ts"],
      }),
    ).toEqual([]);
  });

  test("a derived module produced through prepack is buildable", () => {
    expect(
      scan({ source: 'import type { R } from "./generated/runtime.js";' }),
    ).toEqual([]);
  });

  test("a derived module whose script prepack never reaches is not", () => {
    expect(
      scan({
        source: 'export { r } from "./generated/runtime.js";',
        scripts: {
          build: "tsc",
          "codegen:runtime": "bun run src/codegen.ts",
        },
      }),
    ).toEqual([
      {
        importer,
        specifier: "./generated/runtime.js",
        missing: "packages/probe/src/generated/runtime.ts",
      },
    ]);
  });

  test("an untracked generated module fails at its import site", () => {
    const [violation, ...rest] = scan({
      source: 'const m = await import("./generated/resource-tree.js");',
    });
    expect(rest).toEqual([]);
    expect(violation).toEqual({
      importer,
      specifier: "./generated/resource-tree.js",
      missing: "packages/probe/src/generated/resource-tree.ts",
    });
    expect(formatGeneratedImportViolation(violation ?? panic("none"))).toBe(
      `${importer} imports "./generated/resource-tree.js", but packages/probe/src/generated/resource-tree.ts is neither tracked nor derived by its package's prepack/build scripts`,
    );
  });

  test("a committed manifest output outside generated/ must stay tracked", () => {
    expect(scan({ source: 'import "./contract.gen.js";' })).toEqual([
      {
        importer,
        specifier: "./contract.gen.js",
        missing: "packages/probe/src/contract.gen.ts",
      },
    ]);
  });

  test("ordinary and package imports are left to the compiler", () => {
    expect(
      scan({ source: 'import "./missing.js"; import "@stll/generated";' }),
    ).toEqual([]);
  });

  test("specifiers resolve in the compiler's lookup order", () => {
    expect(specifierCandidates("a/src/x.ts", "./generated/y.js")).toEqual([
      "a/src/generated/y.ts",
      "a/src/generated/y.tsx",
      "a/src/generated/y.d.ts",
      "a/src/generated/y.js",
    ]);
    expect(specifierCandidates("a/src/x.ts", "../generated/data.json")).toEqual(
      ["a/generated/data.json"],
    );
    expect(specifierCandidates("a/src/x.ts", "./generated/y")).toEqual([
      "a/src/generated/y.ts",
      "a/src/generated/y.tsx",
      "a/src/generated/y.d.ts",
      "a/src/generated/y.js",
      "a/src/generated/y.jsx",
      "a/src/generated/y/index.ts",
      "a/src/generated/y/index.tsx",
      "a/src/generated/y/index.d.ts",
      "a/src/generated/y/index.js",
      "a/src/generated/y/index.jsx",
      "a/src/generated/y",
    ]);
  });

  test("the pack closure follows run chains and ignores other scripts", () => {
    expect(
      packScriptClosure({
        prepack: "npm run build",
        build: "bun run --silent a && bun run b",
        a: "bun run a",
        b: "echo b",
        test: "bun run c",
        c: "echo c",
      }),
    ).toEqual(new Set(["prepack", "build", "a", "b"]));
    // `npm pack` also runs `prepare`; a `build` that no pack hook reaches never
    // runs during a clean pack, so it derives nothing for this check.
    expect(
      packScriptClosure({ prepare: "bun run gen", gen: "echo gen" }),
    ).toEqual(new Set(["prepare", "gen"]));
    expect(
      packScriptClosure({ build: "bun run gen", gen: "echo gen" }),
    ).toEqual(new Set());
    // Separators touching a script name still separate commands.
    expect(runTargets("bun run build&& tsc")).toEqual(["build"]);
    expect(runTargets("bun run codegen:runtime;")).toEqual(["codegen:runtime"]);
    expect(runTargets("tsc|bun run a||npm run --silent b")).toEqual(["a", "b"]);
    // A dangling operator is a syntax error: nothing runs.
    expect(runTargets("bun run build &&")).toEqual([]);
    expect(runTargets("echo bun-run run x")).toEqual([]);
    expect(generatorPackageScript(["bun", "scripts/x.ts"])).toBeNull();
    expect(generatorPackageScript(RUNTIME_GENERATOR.write)).toEqual({
      directory: CLI_DIRECTORY,
      script: "codegen:runtime",
    });
  });

  test("every package source imports only buildable generated modules", () => {
    const trackedFiles = run(["git", "ls-files", "-z"], REPO_ROOT)
      .split("\0")
      .filter(Boolean);
    const violations = findUnbuildableGeneratedImports({
      trackedFiles,
      readSource: (file) => readFileSync(path.join(REPO_ROOT, file), "utf-8"),
      readScripts: (directory) =>
        v.parse(
          v.object({
            scripts: v.optional(v.record(v.string(), v.string()), {}),
          }),
          JSON.parse(
            readFileSync(
              path.join(REPO_ROOT, directory, "package.json"),
              "utf-8",
            ),
          ),
        ).scripts,
    });
    expect(violations.map(formatGeneratedImportViolation)).toEqual([]);
  });
});

test(
  "fresh CLI packaging reconstructs runtime sources without changing published files or contracts",
  () => {
    // The compiler reports real paths; macOS links its temporary directory.
    const directory = realpathSync(
      mkdtempSync(path.join(tmpdir(), "stella-cli-runtime-pack-")),
    );
    try {
      const headRevision = run(["git", "rev-parse", "HEAD"], REPO_ROOT).trim();
      const base = exportRevision(path.join(directory, "base"), baseRevision());
      const head = exportRevision(path.join(directory, "head"), headRevision);
      for (const tree of [base, head]) {
        expect(exportedFiles(tree)).toEqual(revisionFiles(tree));
        for (const file of RUNTIME_SOURCES) {
          expect(existsSync(path.join(tree.root, CLI_DIRECTORY, file))).toBe(
            false,
          );
        }
      }

      // Changesets uses version generation independently of runtime generation.
      const versionFile = path.join(
        head.root,
        CLI_DIRECTORY,
        "src/generated/cli-version.ts",
      );
      const committedVersion = readFileSync(versionFile, "utf-8");
      run(
        ["bun", "run", "codegen:version"],
        path.join(head.root, CLI_DIRECTORY),
      );
      expect(readFileSync(versionFile, "utf-8")).toBe(committedVersion);
      for (const file of RUNTIME_SOURCES) {
        expect(existsSync(path.join(head.root, CLI_DIRECTORY, file))).toBe(
          false,
        );
      }

      const baseFiles = packedFiles(base);
      const headFiles = packedFiles(head);
      expect(baseFiles).toEqual(expectedPackedFiles(base));
      expect(headFiles).toEqual(expectedPackedFiles(head));
      for (const file of RUNTIME_SOURCES) {
        expect(headFiles).toContain(file);
      }

      // Only a surface file the revisions actually changed may drift, and the
      // runtime must match the base whenever none of its inputs changed: a
      // difference then means an input the generator manifest does not list.
      // The catalog part is assembled from shards: a changed shard changes it.
      const changedSurface = changedBetween(base, head, [
        ...CLI_CONTRACT_SURFACE_PATHS.map((part) => `${CLI_DIRECTORY}/${part}`),
        `${CLI_DIRECTORY}/capabilities`,
      ]).map((file) =>
        file.startsWith(`${CLI_DIRECTORY}/capabilities/`)
          ? "capability-catalog.json"
          : file.slice(CLI_DIRECTORY.length + 1),
      );
      const drift = findSurfaceDrift({
        head: readSurface({ tree: head, layout: "source" }),
        published: readSurface({ tree: base, layout: "source" }),
      });
      for (const part of drift) {
        expect(changedSurface).toContain(part);
      }
      expect(
        findSurfaceDrift({
          head: readSurface({ tree: head, layout: "source" }),
          published: readSurface({ tree: head, layout: "published" }),
        }),
      ).toEqual([]);
      const headRuntime = readBuiltRuntime(head);
      if (changedBetween(base, head, RUNTIME_GENERATOR.inputs).length === 0) {
        expect(headRuntime).toBe(readBuiltRuntime(base));
      }

      // A tracked source addition derives its source and compiler outputs.
      const probe = "src/pack-probe.ts";
      writeFileSync(
        path.join(head.root, CLI_DIRECTORY, probe),
        "export const packProbe = 1;\n",
      );
      const addedFiles = packedFiles(head);
      const expectedAdded = expectedPackedFiles(head, [probe]);
      expect(addedFiles).toEqual(expectedAdded);
      expect(addedFiles).toContain(probe);
      expect(addedFiles).toContain("dist/pack-probe.js");

      // An untracked fixture can enter npm's broad src allowlist, but never
      // the expected inventory derived from tracked inputs and build outputs.
      const scratch = "src/pack-scratch.txt";
      writeFileSync(
        path.join(head.root, CLI_DIRECTORY, scratch),
        "unexpected fixture\n",
      );
      const contaminated = packedFiles(head);
      expect(contaminated).toEqual([...expectedAdded, scratch].toSorted());
      expect(() =>
        expect(contaminated).toEqual(expectedPackedFiles(head, [probe])),
      ).toThrow("toEqual");

      // Publishing must also work after every ignored output has been removed.
      for (const file of RUNTIME_SOURCES) {
        rmSync(path.join(head.root, CLI_DIRECTORY, file));
      }
      rmSync(path.join(head.root, CLI_DIRECTORY, "dist"), {
        recursive: true,
        force: true,
      });
      run(
        ["npm", "--ignore-scripts=false", "run", "prepublishOnly"],
        path.join(head.root, CLI_DIRECTORY),
      );
      for (const file of RUNTIME_SOURCES) {
        expect(existsSync(path.join(head.root, CLI_DIRECTORY, file))).toBe(
          true,
        );
      }
      expect(readBuiltRuntime(head)).toBe(headRuntime);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  TEST_TIMEOUT_MS,
);
