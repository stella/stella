// Runs after `vite build` inside the web image build. When a PostHog CLI key
// is present, the client chunks are injected with chunk ids and their hidden
// source maps uploaded, so stack frames resolve to source in the tracker
// while the served bundle stays minified. With or without a key, no map file
// survives into the runtime image.
import { panic } from "better-result";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT_PATH = fileURLToPath(new URL("../", import.meta.url));
const DIST_PATH = path.join(WEB_ROOT_PATH, "dist");
const CLIENT_DIST_PATH = path.join(DIST_PATH, "client");
const POSTHOG_CLI_PACKAGE = "@posthog/cli@0.18.0";
const RELEASE_NAME = "stella-web";
// The comment the CLI appends to every chunk it paired with a map. The
// tracker reads it at capture time, so a chunk without it never resolves.
const CHUNK_ID_MARKER = "//# chunkId=";

export type SourcemapPublishPlan =
  | { type: "skip"; reason: "no_api_key" }
  | { type: "publish"; host: string; projectId: string; version: string };

const trimmed = (value: string | undefined): string => value?.trim() ?? "";

/**
 * A key alone opts the build into publishing; the host, project and version
 * are then mandatory, because a silent default would upload the maps to the
 * wrong place or under no release and the failure would only show up later
 * as unresolved frames.
 */
export const planSourcemapPublish = (
  env: Record<string, string | undefined>,
): SourcemapPublishPlan => {
  if (trimmed(env["POSTHOG_CLI_API_KEY"]) === "") {
    return { type: "skip", reason: "no_api_key" };
  }
  const host = trimmed(env["POSTHOG_CLI_HOST"]);
  const projectId = trimmed(env["POSTHOG_CLI_PROJECT_ID"]);
  const version = trimmed(env["STELLA_VERSION"]);
  if (host === "" || projectId === "" || version === "") {
    return panic(
      "POSTHOG_CLI_API_KEY is set, so POSTHOG_CLI_HOST, POSTHOG_CLI_PROJECT_ID and STELLA_VERSION must be set as well",
    );
  }
  return { type: "publish", host, projectId, version };
};

export const listSourcemaps = async (root: string): Promise<string[]> => {
  const files: string[] = [];
  for await (const file of new Bun.Glob("**/*.map").scan({
    absolute: true,
    cwd: root,
  })) {
    files.push(file);
  }
  return files.toSorted();
};

export const removeSourcemaps = async (root: string): Promise<number> => {
  const files = await listSourcemaps(root);
  await Promise.all(files.map((file) => rm(file)));
  const remaining = await listSourcemaps(root);
  if (remaining.length > 0) {
    return panic(`source maps survived removal: ${remaining.join(", ")}`);
  }
  return files.length;
};

/** Every client chunk must carry the injected id, or the upload was partial. */
export const assertChunksInjected = async (
  clientRoot: string,
): Promise<number> => {
  const missing: string[] = [];
  let count = 0;
  for await (const file of new Bun.Glob("assets/*.js").scan({
    absolute: true,
    cwd: clientRoot,
  })) {
    count += 1;
    const source = await readFile(file, "utf-8");
    if (!source.includes(CHUNK_ID_MARKER)) {
      missing.push(path.relative(clientRoot, file));
    }
  }
  if (missing.length > 0) {
    return panic(
      `chunks without an injected id: ${missing.toSorted().join(", ")}`,
    );
  }
  return count;
};

const publish = (plan: Extract<SourcemapPublishPlan, { type: "publish" }>) => {
  const result = Bun.spawnSync(
    [
      "bun",
      "x",
      POSTHOG_CLI_PACKAGE,
      "sourcemap",
      "process",
      "--directory",
      CLIENT_DIST_PATH,
      "--release-name",
      RELEASE_NAME,
      "--release-version",
      plan.version,
    ],
    {
      env: {
        ...Bun.env,
        POSTHOG_CLI_HOST: plan.host,
        POSTHOG_CLI_PROJECT_ID: plan.projectId,
      },
      stderr: "inherit",
      stdout: "inherit",
    },
  );
  if (result.exitCode !== 0) {
    return panic(
      `posthog-cli sourcemap process exited with ${result.exitCode}`,
    );
  }
};

if (import.meta.main) {
  const plan = planSourcemapPublish(Bun.env);
  if (plan.type === "publish") {
    publish(plan);
    const injected = await assertChunksInjected(CLIENT_DIST_PATH);
    console.log(
      `Uploaded source maps for ${injected} client chunks as ${RELEASE_NAME}@${plan.version}.`,
    );
  } else {
    console.log("No POSTHOG_CLI_API_KEY; source maps are not published.");
  }
  const removed = await removeSourcemaps(DIST_PATH);
  console.log(`Removed ${removed} source map files from dist.`);
}
