// Nightly TanStack AI drift report.
//
// We stay on TanStack AI's future versions, so every patch under patches/
// for a @tanstack package, and every provider-wire and chat oracle check,
// has to keep holding on the version published next. This script, run on a
// throwaway CI checkout, answers that ahead of the upgrade:
//
//   1. For each patched @tanstack package: does the patch still apply to the
//      latest published version, is it already upstream (it applies in
//      reverse), or does it conflict?
//   2. With the latest @tanstack/ai* versions installed (the patches that
//      still apply re-keyed to them, the rest dropped), do the provider-wire
//      contract and the chat oracle suites still pass?
//
// It rewrites package.json and the lockfile in place, so never run it on a
// working copy you keep. Report only: it always exits 0 once it has written
// its report (to $GITHUB_STEP_SUMMARY when set, and to stdout).
//
//   bun scripts/tanstack-drift.ts --write-package   (step 1 + rewrite)
//   bun scripts/tanstack-drift.ts --write-package --dry-run   (step 1 only)
//   bun scripts/tanstack-drift.ts --report          (step 2, after bun install)

import { panic } from "better-result";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

const ROOT = path.resolve(import.meta.dir, "..");
const PACKAGE_JSON = path.join(ROOT, "package.json");
const STATE_FILE = path.join(ROOT, ".cache", "tanstack-drift.json");
const REGISTRY = "https://registry.npmjs.org";

type Suite = { command: readonly string[]; directory: string; file: string };

const apiSuite = (file: string): Suite => ({
  command: ["bun", "run", "test", file],
  directory: "apps/api",
  file,
});

/**
 * The suites whose results the report gives: the API's provider-wire and chat
 * oracle suites, and the web half of the recorded-conversation oracle, the one
 * that loads @tanstack/ai-client and @tanstack/ai-react.
 */
const SUITES: readonly Suite[] = [
  apiSuite("src/lib/tanstack-ai-provider-wire.test.ts"),
  apiSuite("src/handlers/chat/provider-wire-replay.integration.test.ts"),
  apiSuite("src/handlers/chat/approval-settlement.integration.test.ts"),
  apiSuite("src/handlers/chat/live-reload-parity.integration.test.ts"),
  apiSuite("src/handlers/chat/recorded-conversations.integration.test.ts"),
  apiSuite("src/handlers/chat/tool-call-end-arguments.test.ts"),
  {
    command: [
      "bun",
      "test",
      "--isolate",
      "src/components/chat/recorded-conversations.dom.test.tsx",
    ],
    directory: "apps/web",
    file: "src/components/chat/recorded-conversations.dom.test.tsx",
  },
];

/**
 * The install step's outcome, from the workflow. A latest package set that
 * does not install is drift too; the report says so instead of running the
 * suites against whatever the failed install left behind.
 */
const INSTALL_OUTCOME_ENV = "TANSTACK_DRIFT_INSTALL_OUTCOME";
const INSTALL_SUCCEEDED = "success";

type PatchVerdict = "applies" | "upstream" | "conflicts" | "unknown";

const driftStateSchema = v.object({
  packages: v.array(
    v.object({ latest: v.string(), name: v.string(), pinned: v.string() }),
  ),
  patches: v.array(
    v.object({
      file: v.string(),
      latest: v.string(),
      name: v.string(),
      pinned: v.string(),
      verdict: v.picklist(["applies", "upstream", "conflicts", "unknown"]),
    }),
  ),
});

type DriftState = v.InferOutput<typeof driftStateSchema>;

type PackageJson = {
  catalog?: Record<string, string>;
  patchedDependencies?: Record<string, string>;
} & Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readPackageJson = (): PackageJson => {
  const parsed: unknown = JSON.parse(readFileSync(PACKAGE_JSON, "utf-8"));
  return isRecord(parsed) ? parsed : panic("package.json is not an object");
};

const isTanStackAi = (name: string): boolean =>
  name === "@tanstack/ai" ||
  name.startsWith("@tanstack/ai-") ||
  name === "@tanstack/openai-base";

type Published = {
  dependencies: Record<string, string>;
  tarball: string;
  version: string;
};

/** `name` as published under `tag` (a dist-tag or an exact version). */
const publishedOf = async (
  name: string,
  tag = "latest",
): Promise<Published> => {
  const response = await fetch(`${REGISTRY}/${name}/${tag}`);
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body["version"] !== "string") {
    return panic(`No ${tag} version for ${name}`);
  }
  const dist = body["dist"];
  const tarball = isRecord(dist) ? dist["tarball"] : undefined;
  const dependencies: Record<string, string> = {};
  const declared = body["dependencies"];
  if (isRecord(declared)) {
    for (const [dependency, spec] of Object.entries(declared)) {
      if (typeof spec === "string") {
        dependencies[dependency] = spec;
      }
    }
  }
  return typeof tarball === "string"
    ? { dependencies, tarball, version: body["version"] }
    : panic(`No tarball for ${name}`);
};

/** The highest version of `name` published on the registry that `range` admits. */
const highestSatisfying = async (
  name: string,
  range: string,
): Promise<string> => {
  const response = await fetch(`${REGISTRY}/${name}`);
  const body: unknown = await response.json();
  const versions = isRecord(body) ? body["versions"] : undefined;
  if (!isRecord(versions)) {
    return panic(`No published versions for ${name}`);
  }
  const admitted = Object.keys(versions)
    .filter((version) => Bun.semver.satisfies(version, range))
    .toSorted(Bun.semver.order);
  return admitted.at(-1) ?? panic(`No ${name} version satisfies ${range}`);
};

const run = (command: string[], cwd: string) => {
  const result = Bun.spawnSync(command, {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    ok: result.exitCode === 0,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
};

/** Whether `patchFile` applies to the package published at `tarball`. */
const verdictFor = async (
  tarball: string,
  patchFile: string,
): Promise<PatchVerdict> => {
  const directory = mkdtempSync(path.join(tmpdir(), "tanstack-drift-"));
  try {
    const archive = path.join(directory, "package.tgz");
    writeFileSync(
      archive,
      new Uint8Array(await (await fetch(tarball)).arrayBuffer()),
    );
    if (!run(["tar", "-xzf", archive], directory).ok) {
      return "unknown";
    }
    const packageDirectory = path.join(directory, "package");
    // Only the source hunks: `bun patch` can record its own marker file, whose
    // header git cannot read.
    const patch = path.join(directory, "source.patch");
    writeFileSync(
      patch,
      readFileSync(path.join(ROOT, patchFile), "utf-8").replaceAll(
        /diff --git a\/\S*\.bun-tag-\S+ b\/\S+\nnew file mode \d+\nindex \S+\n/gu,
        "",
      ),
    );
    if (run(["git", "apply", "--check", patch], packageDirectory).ok) {
      return "applies";
    }
    if (
      run(["git", "apply", "--check", "--reverse", patch], packageDirectory).ok
    ) {
      return "upstream";
    }
    return "conflicts";
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

const splitPatchKey = (key: string): { name: string; version: string } => {
  const at = key.lastIndexOf("@");
  return at <= 0
    ? panic(`Unexpected patch key ${key}`)
    : { name: key.slice(0, at), version: key.slice(at + 1) };
};

const writePackage = async (): Promise<void> => {
  const manifest = readPackageJson();
  const catalog = manifest.catalog ?? {};
  const packages: DriftState["packages"] = [];
  const published = new Map<string, Published>();
  for (const [name, pinned] of Object.entries(catalog)) {
    if (isTanStackAi(name)) {
      const latest = await publishedOf(name);
      published.set(name, latest);
      packages.push({ latest: latest.version, name, pinned });
      catalog[name] = latest.version;
    }
  }
  // A patched package outside the catalog (a transitive one) is installed at
  // the highest version its latest dependents' spec admits, exact or a range,
  // which is what `bun install` resolves on a fresh lockfile.
  const installedVersionOf = async (
    name: string,
  ): Promise<string | undefined> => {
    for (const release of published.values()) {
      const spec = release.dependencies[name];
      if (spec !== undefined) {
        return highestSatisfying(name, spec);
      }
    }
    return published.get(name)?.version;
  };
  const patched: Record<string, string> = {};
  const patches: DriftState["patches"] = [];
  for (const [key, file] of Object.entries(
    manifest.patchedDependencies ?? {},
  )) {
    const { name, version } = splitPatchKey(key);
    if (!isTanStackAi(name)) {
      patched[key] = file;
      continue;
    }
    const target = await installedVersionOf(name);
    const latest = await publishedOf(name, target);
    const verdict = await verdictFor(latest.tarball, file);
    patches.push({
      file,
      latest: latest.version,
      name,
      pinned: version,
      verdict,
    });
    if (verdict === "applies") {
      patched[`${name}@${latest.version}`] = file;
    }
  }
  const state: DriftState = { packages, patches };
  if (process.argv.includes("--dry-run")) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  manifest.catalog = catalog;
  manifest.patchedDependencies = patched;
  writeFileSync(PACKAGE_JSON, `${JSON.stringify(manifest, null, 2)}\n`);
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
  console.log(JSON.stringify(state, null, 2));
};

const report = (): void => {
  const state = v.parse(
    driftStateSchema,
    JSON.parse(readFileSync(STATE_FILE, "utf-8")),
  );
  const lines = [
    "## TanStack AI drift",
    "",
    "| package | pinned | latest |",
    "| --- | --- | --- |",
    ...state.packages.map(
      ({ latest, name, pinned }) =>
        `| ${name} | ${pinned} | ${latest}${latest === pinned ? "" : " (new)"} |`,
    ),
    "",
    "| patch | pinned | latest | verdict |",
    "| --- | --- | --- | --- |",
    ...state.patches.map(
      ({ file, latest, pinned, verdict }) =>
        `| ${path.basename(file)} | ${pinned} | ${latest} | ${verdict} |`,
    ),
    "",
  ];
  const installOutcome = process.env[INSTALL_OUTCOME_ENV] ?? INSTALL_SUCCEEDED;
  if (installOutcome === INSTALL_SUCCEEDED) {
    lines.push("| suite | result |", "| --- | --- |");
    for (const { command, directory, file } of SUITES) {
      const { ok, output } = run([...command], path.join(ROOT, directory));
      const counts = [...output.matchAll(/^ (\d+) (pass|fail)$/gmu)]
        .map(([, count = "", kind = ""]) => `${count} ${kind}`)
        .join(", ");
      const suite = `${directory}/${file}`;
      lines.push(`| ${suite} | ${ok ? "pass" : "FAIL"} (${counts}) |`);
      if (!ok) {
        const failures = output
          .split("\n")
          .filter(
            (line) => line.startsWith("(fail)") || line.includes('"oracle"'),
          )
          .slice(0, 20);
        console.log(`--- ${suite}\n${failures.join("\n")}`);
      }
    }
  } else {
    lines.push(
      `The latest TanStack AI packages did not install (${installOutcome}); no suite ran.`,
    );
  }
  const summary = `${lines.join("\n")}\n`;
  console.log(summary);
  const stepSummary = process.env["GITHUB_STEP_SUMMARY"];
  if (stepSummary !== undefined && stepSummary !== "") {
    appendFileSync(stepSummary, summary);
  }
};

if (import.meta.main) {
  if (process.argv.includes("--write-package")) {
    await writePackage();
  } else if (process.argv.includes("--report")) {
    report();
  } else {
    panic("Usage: tanstack-drift.ts --write-package | --report");
  }
}
