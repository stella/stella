import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BUILD_KIND,
  type BuildKind,
  LOCAL_DEV_OPT_IN,
  NODE_ENV,
  resolveRuntimeMode,
} from "./index";

// Build and run matrix over the real resolver. Bun inlines direct
// `process.env.NODE_ENV` reads (with `--env=inline`, every direct read) at
// build time, so a unit test of the resolver cannot show that the mode follows
// the environment an artifact runs in. Each artifact prints the resolved mode
// next to a direct NODE_ENV read, which shows what the build inlined.

type Environment = Readonly<Record<string, string>>;

const OPT_IN = { [LOCAL_DEV_OPT_IN.name]: LOCAL_DEV_OPT_IN.value } as const;
const LOCAL_BUILD_ENV = { NODE_ENV: NODE_ENV.development, ...OPT_IN } as const;
const RELEASE_FLAGS = ["--define", "__STELLA_RELEASE__=true"] as const;
const CONFIGURATION_ERROR = "configuration error";

const OUTPUT = {
  source: "source",
  bundle: "bundle",
  compiled: "compiled",
} as const;

type ArtifactSpec = {
  name: string;
  output: (typeof OUTPUT)[keyof typeof OUTPUT];
  flags: readonly string[];
  buildEnv: Environment;
  buildKind: BuildKind;
};

const ARTIFACTS = [
  {
    name: "entry.ts",
    output: OUTPUT.source,
    flags: [],
    buildEnv: {},
    buildKind: BUILD_KIND.source,
  },
  {
    name: "bundle-unset.js",
    output: OUTPUT.bundle,
    flags: [],
    buildEnv: {},
    buildKind: BUILD_KIND.source,
  },
  {
    name: "bundle-local.js",
    output: OUTPUT.bundle,
    flags: [],
    buildEnv: LOCAL_BUILD_ENV,
    buildKind: BUILD_KIND.source,
  },
  {
    name: "bundle-minified.js",
    output: OUTPUT.bundle,
    flags: ["--minify"],
    buildEnv: LOCAL_BUILD_ENV,
    buildKind: BUILD_KIND.source,
  },
  {
    name: "bundle-inlined.js",
    output: OUTPUT.bundle,
    flags: ["--env=inline"],
    buildEnv: LOCAL_BUILD_ENV,
    buildKind: BUILD_KIND.source,
  },
  {
    name: "bundle-production.js",
    output: OUTPUT.bundle,
    flags: [],
    buildEnv: { NODE_ENV: NODE_ENV.production },
    buildKind: BUILD_KIND.source,
  },
  {
    name: "bundle-release.js",
    output: OUTPUT.bundle,
    flags: RELEASE_FLAGS,
    buildEnv: LOCAL_BUILD_ENV,
    buildKind: BUILD_KIND.release,
  },
  {
    name: "compiled-local",
    output: OUTPUT.compiled,
    flags: [],
    buildEnv: LOCAL_BUILD_ENV,
    buildKind: BUILD_KIND.source,
  },
  {
    name: "compiled-release",
    output: OUTPUT.compiled,
    flags: RELEASE_FLAGS,
    buildEnv: LOCAL_BUILD_ENV,
    buildKind: BUILD_KIND.release,
  },
] as const satisfies readonly ArtifactSpec[];

const RUN_ENVIRONMENTS: readonly Environment[] = [
  {},
  { NODE_ENV: NODE_ENV.development },
  { NODE_ENV: NODE_ENV.development, ...OPT_IN },
  { NODE_ENV: NODE_ENV.test, ...OPT_IN },
  { NODE_ENV: NODE_ENV.staging, ...OPT_IN },
  { NODE_ENV: NODE_ENV.production },
  { NODE_ENV: NODE_ENV.production, ...OPT_IN },
  { NODE_ENV: NODE_ENV.development, [LOCAL_DEV_OPT_IN.name]: "true" },
];

let directory = "";

const spawn = (cmd: string[], env: Environment) =>
  Bun.spawnSync({
    cmd,
    cwd: directory,
    env: { PATH: process.env["PATH"] ?? "", ...env },
    stderr: "pipe",
    stdout: "pipe",
  });

const OUTPUT_FLAGS = {
  source: [],
  bundle: [],
  compiled: ["--compile", "--no-compile-autoload-dotenv"],
} as const satisfies Record<ArtifactSpec["output"], readonly string[]>;

const runCommand = (artifact: ArtifactSpec): string[] => {
  const file = path.join(directory, artifact.name);
  switch (artifact.output) {
    case OUTPUT.source:
    case OUTPUT.bundle:
      return [process.execPath, "--no-env-file", file];
    case OUTPUT.compiled:
      return [file];
    default: {
      artifact.output satisfies never;
      return panic(`unhandled output ${String(artifact.output)}`);
    }
  }
};

type Observation = { mode: string; inlined: string | null };

const parseObservation = (text: string): Observation => {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("mode" in parsed) ||
    typeof parsed.mode !== "string" ||
    !("inlined" in parsed)
  ) {
    return panic(`unexpected artifact output: ${text}`);
  }
  return {
    mode: parsed.mode,
    inlined: typeof parsed.inlined === "string" ? parsed.inlined : null,
  };
};

const observe = (artifact: ArtifactSpec, env: Environment): string => {
  const result = spawn(runCommand(artifact), env);
  return result.exitCode === 0
    ? parseObservation(result.stdout.toString()).mode
    : CONFIGURATION_ERROR;
};

const expectedOutcome = (env: Environment, buildKind: BuildKind): string => {
  const resolved = resolveRuntimeMode({
    nodeEnv: env["NODE_ENV"],
    localDevOptIn: env[LOCAL_DEV_OPT_IN.name],
    buildKind,
  });
  return Result.isOk(resolved)
    ? resolved.value.runtimeMode.mode
    : CONFIGURATION_ERROR;
};

beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), "stella-runtime-mode-"));
  const owner = path.join(import.meta.dir, "index.ts");
  writeFileSync(
    path.join(directory, "entry.ts"),
    `import { readRuntimeMode } from ${JSON.stringify(owner)};
const inlined = process.env.NODE_ENV ?? null;
process.stdout.write(JSON.stringify({ mode: readRuntimeMode().runtimeMode.mode, inlined }));
`,
  );
  for (const artifact of ARTIFACTS) {
    if (artifact.output === OUTPUT.source) {
      continue;
    }
    const result = spawn(
      [
        process.execPath,
        "build",
        "--target=bun",
        ...OUTPUT_FLAGS[artifact.output],
        ...artifact.flags,
        "--outfile",
        path.join(directory, artifact.name),
        "entry.ts",
      ],
      artifact.buildEnv,
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  }
}, 240_000);

afterAll(() => {
  if (directory !== "") {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("runtime mode across build and run environments", () => {
  test("follows the run environment, never the build environment", () => {
    for (const artifact of ARTIFACTS) {
      for (const env of RUN_ENVIRONMENTS) {
        expect(
          observe(artifact, env),
          `${artifact.name} run with ${JSON.stringify(env)}`,
        ).toBe(expectedOutcome(env, artifact.buildKind));
      }
    }
  }, 240_000);

  test("the bundles inline their build-time NODE_ENV", () => {
    const result = spawn(
      [
        process.execPath,
        "--no-env-file",
        path.join(directory, "bundle-unset.js"),
      ],
      { NODE_ENV: NODE_ENV.production },
    );

    expect(parseObservation(result.stdout.toString())).toEqual({
      mode: "strict",
      inlined: NODE_ENV.development,
    });
  });

  test("a release build never opens", () => {
    const releases = ARTIFACTS.filter(
      ({ buildKind }) => buildKind === BUILD_KIND.release,
    );

    expect(releases.length).toBeGreaterThan(0);
    for (const artifact of releases) {
      expect(
        observe(artifact, { NODE_ENV: NODE_ENV.development, ...OPT_IN }),
      ).toBe(CONFIGURATION_ERROR);
    }
  });
});
