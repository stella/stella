import { TaggedError } from "better-result";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import {
  generatedFileHash,
  reusableResultRun,
  trackedInputHash,
} from "../packages/scripts/src/prepared-generated-sources";

class WindowsResultError extends TaggedError("WindowsResultError")<{
  message: string;
}> {}

const toolVersionSchema = v.pipe(v.string(), v.minLength(1));
const resolvedToolsSchema = v.object({
  bun: toolVersionSchema,
  rust: toolVersionSchema,
  cargo: toolVersionSchema,
  node: toolVersionSchema,
  tauri: toolVersionSchema,
  image: toolVersionSchema,
  os: toolVersionSchema,
  visualStudio: toolVersionSchema,
  msvc: toolVersionSchema,
  sdk: toolVersionSchema,
});
const artifactListSchema = v.object({
  artifacts: v.array(
    v.object({
      name: v.string(),
      expired: v.boolean(),
      workflow_run: v.nullable(v.object({ id: v.number() })),
    }),
  ),
});
const runSchema = v.object({
  id: v.number(),
  event: v.string(),
  conclusion: v.nullable(v.string()),
  path: v.string(),
});

type WindowsResultKeyOptions = {
  root: string;
  tools: Record<string, string>;
  profile: string;
  workflow: string;
};

export const windowsResultKey = ({
  root,
  tools,
  profile,
  workflow,
}: WindowsResultKeyOptions) => {
  if (Object.keys(tools).length === 0 || !profile || !workflow) {
    throw new WindowsResultError({
      message: "Incomplete Windows build identity",
    });
  }
  const resolved = v.parse(resolvedToolsSchema, tools);
  // Include generated files and every tracked recipe/configuration: the desktop
  // build consumes workspace packages as well as its own source tree.
  // Dry-run CI embeds fixed telemetry metadata, so commit identity is not a
  // build input. The tracked and executed recipes still cover that stamping.
  return trackedInputHash(root, {
    excluded: new Set(),
    context: {
      tools: Object.fromEntries(
        Object.entries(resolved).toSorted(([a], [b]) => {
          if (a === b) {
            return 0;
          }
          return a < b ? -1 : 1;
        }),
      ),
      profile,
      workflowHash: generatedFileHash(workflow),
    },
  });
};

type FindWindowsResultOptions = {
  key: string;
  event: string;
  repository: string;
  destination: string;
  run: (args: string[]) => string;
  readManifest: () => unknown;
};

export const findWindowsResult = ({
  key,
  event,
  repository,
  destination,
  run,
  readManifest,
}: FindWindowsResultOptions) => {
  // Never consume a prior proof at the gate that is responsible for producing it.
  if (event === "merge_group") {
    return undefined;
  }
  const name = `desktop-windows-dry-run-${key}`;
  const { artifacts } = v.parse(
    artifactListSchema,
    JSON.parse(
      run([
        "api",
        `repos/${repository}/actions/artifacts?name=${name}&per_page=100`,
      ]),
    ),
  );
  for (const artifact of artifacts) {
    if (artifact.name !== name || artifact.expired || !artifact.workflow_run) {
      continue;
    }
    const id = artifact.workflow_run.id;
    const proof = v.parse(
      runSchema,
      JSON.parse(run(["api", `repos/${repository}/actions/runs/${id}`])),
    );
    if (
      proof.id !== id ||
      proof.event !== "merge_group" ||
      proof.conclusion !== "success" ||
      proof.path !== ".github/workflows/ci.yml"
    ) {
      continue;
    }
    run([
      "run",
      "download",
      String(id),
      "--repo",
      repository,
      "--name",
      name,
      "--dir",
      destination,
    ]);
    const reused = reusableResultRun(readManifest(), key, event);
    if (reused === String(id)) {
      return reused;
    }
    return undefined;
  }
  return undefined;
};

if (import.meta.main) {
  const root = process.cwd();
  const destination = path.join(
    process.env["RUNNER_TEMP"] ?? ".cache",
    "windows-result",
  );
  const manifestPath = path.join(destination, "manifest.json");
  const output = process.env["GITHUB_OUTPUT"];
  const emit = (line: string) => {
    if (output) {
      writeFileSync(output, `${line}\n`, { flag: "a" });
    }
  };
  const command = (args: string[]) => {
    const result = Bun.spawnSync(args, { cwd: root, timeout: 20_000 });
    if (result.exitCode !== 0) {
      throw new WindowsResultError({
        message: `Windows result command failed: ${args.at(0)}`,
      });
    }
    return result.stdout.toString().trim();
  };
  const githubCommand = (args: string[]) =>
    command([
      "bash",
      process.env["GH_RETRY_SCRIPT"] ?? path.join(root, "scripts/gh-retry.sh"),
      ...args,
    ]);
  // This optional CI boundary fails closed: unavailable tools, inventory, API,
  // download or manifest always leave the expensive build enabled.
  try {
    const tools = v.parse(
      resolvedToolsSchema,
      JSON.parse(
        readFileSync(
          path.join(
            process.env["RUNNER_TEMP"] ?? ".cache",
            "windows-tools.json",
          ),
          "utf-8",
        ),
      ),
    );
    const key = windowsResultKey({
      root,
      tools,
      profile: process.env["WINDOWS_BUILD_PROFILE"] ?? "",
      // Reusable CI can execute a newer recipe than the pinned source checkout.
      workflow: (() => {
        const workflowSha = process.env["WINDOWS_WORKFLOW_SHA"];
        if (!workflowSha) {
          throw new WindowsResultError({
            message: "Missing executed workflow revision",
          });
        }
        if (command(["git", "rev-parse", "HEAD"]) === workflowSha) {
          return readFileSync(
            path.join(root, ".github/workflows/ci.yml"),
            "utf-8",
          );
        }
        const file = v.parse(
          v.object({ content: v.string(), encoding: v.literal("base64") }),
          JSON.parse(
            githubCommand([
              "api",
              `repos/${process.env["GITHUB_REPOSITORY"]}/contents/.github/workflows/ci.yml?ref=${workflowSha}`,
            ]),
          ),
        );
        return Buffer.from(file.content, "base64").toString("utf-8");
      })(),
    });
    mkdirSync(destination, { recursive: true });
    emit(`key=${key}`);
    const reused = findWindowsResult({
      key,
      event: process.env["GITHUB_EVENT_NAME"] ?? "",
      repository: process.env["GITHUB_REPOSITORY"] ?? "",
      destination,
      run: githubCommand,
      readManifest: () => JSON.parse(readFileSync(manifestPath, "utf-8")),
    });
    if (reused) {
      const message = `reused ${key} from run ${reused}`;
      console.log(message);
      const summary = process.env["GITHUB_STEP_SUMMARY"];
      if (summary) {
        writeFileSync(summary, `${message}\n`, { flag: "a" });
      }
      emit("reused=true");
    } else {
      // Upload is conditioned on a successful build and merge_group in ci.yml.
      writeFileSync(
        manifestPath,
        JSON.stringify({
          inputHash: key,
          runId: process.env["GITHUB_RUN_ID"],
          event: "merge_group",
          conclusion: "success",
        }),
      );
    }
  } catch (error) {
    console.log(
      `Windows dry-run receipt unavailable; running full build: ${error instanceof Error ? error.message : "unknown failure"}`,
    );
  }
}
