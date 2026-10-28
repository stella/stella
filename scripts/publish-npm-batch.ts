import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type ReadyPublishPackage = {
  status: "ready";
  name: string;
  manifest: string;
  artifactDirectory: string;
  dependencies: readonly string[];
};

type PublishPackage =
  | ReadyPublishPackage
  | {
      status: "invalid";
      name: string;
      dependencies: readonly string[];
      error: string;
    };

type PublishOutcome =
  | { status: "published"; name: string }
  | { status: "failed" | "skipped"; name: string; error: string };

type PublishBatchOptions = {
  packages: readonly PublishPackage[];
  publish: (pkg: ReadyPublishPackage) => string | null;
};

// Resolve the selected graph rather than assuming a maintained list is ordered.
// Only selected dependencies participate; unselected versions are on npm already.
export const publishBatch = ({ packages, publish }: PublishBatchOptions) => {
  const pending = new Map(packages.map((pkg) => [pkg.name, pkg]));
  assert.equal(pending.size, packages.length, "Duplicate publish package");
  const outcomes = new Map<string, PublishOutcome>();
  while (pending.size > 0) {
    const ready = [...pending.values()].filter(({ dependencies }) =>
      dependencies.every((dependency) => !pending.has(dependency)),
    );
    if (ready.length === 0) {
      for (const pkg of pending.values()) {
        outcomes.set(pkg.name, {
          status: "failed",
          name: pkg.name,
          error: `Dependency cycle prevents publication: ${pkg.dependencies.filter((dependency) => pending.has(dependency)).join(", ")}`,
        });
      }
      break;
    }
    for (const pkg of ready) {
      if (pkg.status === "invalid") {
        outcomes.set(pkg.name, {
          status: "failed",
          name: pkg.name,
          error: pkg.error,
        });
        pending.delete(pkg.name);
        continue;
      }
      const blocked = pkg.dependencies.flatMap((dependency) => {
        const outcome = outcomes.get(dependency);
        return outcome && outcome.status !== "published"
          ? [`${dependency} (${outcome.status}): ${outcome.error}`]
          : [];
      });
      if (blocked.length > 0) {
        outcomes.set(pkg.name, {
          status: "skipped",
          name: pkg.name,
          error: `Dependency unavailable: ${blocked.join("; ")}`,
        });
        pending.delete(pkg.name);
        continue;
      }
      let failureMessage: string | null;
      // This is the package transaction boundary: a malformed shared-tool
      // response or filesystem failure must not stop unrelated transactions.
      try {
        failureMessage = publish(pkg);
      } catch (error) {
        failureMessage = error instanceof Error ? error.message : String(error);
      }
      outcomes.set(
        pkg.name,
        failureMessage === null
          ? { status: "published", name: pkg.name }
          : { status: "failed", name: pkg.name, error: failureMessage },
      );
      pending.delete(pkg.name);
    }
  }
  return [...outcomes.values()];
};

export const publishReport = (outcomes: readonly PublishOutcome[]) => {
  const lines = ["npm publish results", ""];
  for (const outcome of outcomes) {
    lines.push(`${outcome.name}: ${outcome.status}`);
    if (outcome.status !== "published") {
      lines.push(outcome.error);
    }
    lines.push("");
  }
  return lines.join("\n");
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const readPublishPackages = (
  manifests: readonly string[],
  artifactRoot: string,
): PublishPackage[] =>
  manifests.map((manifest) => {
    const match = /^packages\/([a-z0-9-]+)\/package\.json$/u.exec(manifest);
    const directory = match?.at(1);
    assert.ok(directory, `Invalid publish manifest: ${manifest}`);
    const name = `@stll/${directory}`;
    // Each manifest is a package boundary. Reject bad metadata for that
    // package while retaining its identity so consumers can be skipped.
    try {
      const data: unknown = JSON.parse(readFileSync(manifest, "utf-8"));
      assert.ok(
        isRecord(data) && data["name"] === name,
        `Invalid package name in ${manifest}`,
      );
      const dependencies = [
        "dependencies",
        "optionalDependencies",
        "peerDependencies",
      ].flatMap((group) => {
        const entries = data[group];
        return isRecord(entries) ? Object.keys(entries) : [];
      });
      return {
        status: "ready",
        name,
        manifest,
        artifactDirectory: path.join(artifactRoot, `npm-tarball-${directory}`),
        dependencies,
      };
    } catch (error) {
      return {
        status: "invalid",
        name,
        dependencies: [],
        error: `${manifest}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });

type ReleaseProcessOptions = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

const executeReleaseProcess = ({ command, args, env }: ReleaseProcessOptions) =>
  spawnSync(command, args, {
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
    env,
  });

type PublishTransactionOptions = {
  pkg: ReadyPublishPackage;
  sharedTooling: string;
  hardenedTooling: string;
  temporaryRoot: string;
  timeoutMilliseconds: number;
  execute?: typeof executeReleaseProcess;
};

type ReleaseCommandOptions = {
  command: string;
  args: string[];
  envOverrides?: Readonly<Record<string, string>>;
};

export const publishTransaction = ({
  pkg,
  sharedTooling,
  hardenedTooling,
  temporaryRoot,
  timeoutMilliseconds,
  execute = executeReleaseProcess,
}: PublishTransactionOptions): string | null => {
  const temporary = mkdtempSync(path.join(temporaryRoot, "npm-package-"));
  const output = path.join(temporary, "prepare-output");
  const deadline = Date.now() + timeoutMilliseconds;
  const env = {
    ...process.env,
    ARTIFACT_DIRECTORY: pkg.artifactDirectory,
    PACKAGE_FILES: pkg.manifest,
    GITHUB_OUTPUT: output,
    GITHUB_LATEST_POLICY: "preserve",
    GITHUB_LATEST_PACKAGE: "",
    DIST_TAG: "latest",
  };
  const run = ({ command, args, envOverrides = {} }: ReleaseCommandOptions) => {
    const remainingMilliseconds = deadline - Date.now();
    if (remainingMilliseconds <= 0) {
      return "Package transaction deadline exceeded";
    }
    // GNU timeout owns the process group on the Ubuntu release runner. Killing
    // only the bash wrapper could leave npm publishing after this package fails.
    const result = execute({
      command: "timeout",
      args: [
        "--kill-after=5s",
        "--signal=TERM",
        `${remainingMilliseconds / 1000}s`,
        command,
        ...args,
      ],
      env: { ...env, ...envOverrides },
    });
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    return result.status === 0
      ? null
      : `${command} ${args.join(" ")}: ${result.error?.message ?? `exit ${result.status}, signal ${result.signal ?? "none"}`}\n${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  };
  try {
    const prepared = run({
      command: "node",
      args: [path.join(sharedTooling, "prepare.mjs")],
    });
    if (prepared !== null) {
      return prepared;
    }
    const outputs = readFileSync(output, "utf-8");
    // The shared action writes multiline outputs with a randomized delimiter.
    const declaration = /^tarballs<<([^\n]+)\n([\s\S]*?)\n\1(?:\n|$)/mu.exec(
      outputs,
    );
    assert.ok(
      declaration,
      "Shared release prepare omitted its tarballs output",
    );
    const tarballs = declaration.at(2) ?? "";
    if (tarballs !== "") {
      const published = run({
        command: "bash",
        args: ["-eo", "pipefail", path.join(hardenedTooling, "publish.sh")],
        envOverrides: { TARBALL: "", TARBALLS: tarballs },
      });
      if (published !== null) {
        return published;
      }
    }
    return run({
      command: "node",
      args: [path.join(sharedTooling, "finalize.mjs")],
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
};

const entryPoint = process.argv.at(1);
const PUBLISH_BATCH_TIMEOUT_MILLISECONDS = 40 * 60_000;
if (
  entryPoint &&
  import.meta.url === pathToFileURL(path.resolve(entryPoint)).href
) {
  const manifests = (process.env["PACKAGE_FILES"] ?? "")
    .split("\n")
    .filter(Boolean);
  assert.ok(manifests.length > 0, "No packages selected for publishing");
  const sharedTooling = process.env["SHARED_RELEASE_TOOLING"];
  const hardenedTooling = process.env["HARDENED_PUBLISH_TOOLING"];
  const temporaryRoot = process.env["RUNNER_TEMP"];
  assert.ok(
    sharedTooling && hardenedTooling && temporaryRoot,
    "Missing release tooling",
  );
  const outcomes = publishBatch({
    packages: readPublishPackages(manifests, "release-artifacts"),
    publish: (pkg) =>
      publishTransaction({
        pkg,
        sharedTooling,
        hardenedTooling,
        temporaryRoot,
        // Reserve five minutes of the workflow step for reporting and setup.
        // One stuck transaction must leave time for every selected sibling.
        timeoutMilliseconds: Math.floor(
          PUBLISH_BATCH_TIMEOUT_MILLISECONDS / manifests.length,
        ),
      }),
  });
  const report = publishReport(outcomes);
  console.log(report);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary) {
    appendFileSync(
      summary,
      `<pre>${report.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</pre>\n`,
    );
  }
  if (outcomes.some(({ status }) => status !== "published")) {
    process.exitCode = 1;
  }
}
