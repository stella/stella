// Runs after `vite build` inside the web image build. When the build opts
// into publishing, the client chunks are injected with chunk ids and their
// hidden source maps uploaded, so stack frames resolve to source in the
// tracker while the served bundle stays minified. Whether or not it
// publishes, no map file survives into the runtime image.
import { panic } from "better-result";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { repoRelativePath } from "@stll/portable-path";

const WEB_ROOT_PATH = fileURLToPath(new URL("../", import.meta.url));
const DIST_PATH = path.join(WEB_ROOT_PATH, "dist");
const CLIENT_DIST_PATH = path.join(DIST_PATH, "client");
const POSTHOG_CLI_PACKAGE = "@posthog/cli@0.18.0";
const RELEASE_NAME = "stella-web";
// The comment the CLI appends to every chunk it paired with a map. The
// tracker reads it at capture time, so a chunk without it never resolves.
const CHUNK_ID_MARKER = "//# chunkId=";
const SOURCEMAP_UPLOAD_ATTEMPTS = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
const RETRY_JITTER_MIN = 0.5;
const RETRY_JITTER_RANGE = 1;

export type SourcemapProcessResult = {
  exitCode: number;
  stderr: string;
};

type PublishWithRetryOptions = {
  run: () => SourcemapProcessResult;
  sleep: (milliseconds: number) => Promise<void>;
  random: () => number;
  log: (message: string) => void;
  attempts?: number;
};

export type SourcemapPublishPlan =
  | { type: "skip" }
  | {
      type: "publish";
      apiKey: string;
      host: string;
      projectId: string;
      version: string;
    };

const trimmed = (value: string | undefined): string => value?.trim() ?? "";

const isHttpsUrl = (value: string): boolean => {
  if (!URL.canParse(value)) {
    return false;
  }
  return new URL(value).protocol === "https:";
};

/**
 * Publishing is an explicit, non-secret opt-in (`POSTHOG_SOURCEMAP_PUBLISH`)
 * rather than "a key happens to be present": the build argument is part of
 * the image cache key, so a cached no-publish layer can never stand in for
 * a publishing build, and a build that opts in without its key or
 * destination fails here instead of shipping unresolvable frames.
 */
export const planSourcemapPublish = (
  env: Record<string, string | undefined>,
): SourcemapPublishPlan => {
  if (trimmed(env["POSTHOG_SOURCEMAP_PUBLISH"]) !== "true") {
    return { type: "skip" };
  }
  const apiKey = trimmed(env["POSTHOG_CLI_API_KEY"]);
  const host = trimmed(env["POSTHOG_CLI_HOST"]);
  const projectId = trimmed(env["POSTHOG_CLI_PROJECT_ID"]);
  const version = trimmed(env["STELLA_VERSION"]);
  if (apiKey === "" || host === "" || projectId === "" || version === "") {
    return panic(
      "POSTHOG_SOURCEMAP_PUBLISH=true requires POSTHOG_CLI_API_KEY, POSTHOG_CLI_HOST, POSTHOG_CLI_PROJECT_ID and STELLA_VERSION",
    );
  }
  // The key rides in a bearer header; a plain-text host would send it in
  // the clear.
  if (!isHttpsUrl(host)) {
    return panic("POSTHOG_CLI_HOST must be an https:// URL");
  }
  return { type: "publish", apiKey, host, projectId, version };
};

export type SourcemapProcessCommand = {
  cmd: string[];
  env: Record<string, string>;
};

/** The CLI invocation for a plan: `inject` and `upload` in one pass. */
export const sourcemapProcessCommand = (
  plan: Extract<SourcemapPublishPlan, { type: "publish" }>,
  clientRoot: string,
): SourcemapProcessCommand => ({
  cmd: [
    "bun",
    "x",
    POSTHOG_CLI_PACKAGE,
    "sourcemap",
    "process",
    "--directory",
    clientRoot,
    "--release-name",
    RELEASE_NAME,
    "--release-version",
    plan.version,
  ],
  env: {
    POSTHOG_CLI_API_KEY: plan.apiKey,
    POSTHOG_CLI_HOST: plan.host,
    POSTHOG_CLI_PROJECT_ID: plan.projectId,
  },
});

export const isTransientSourcemapProcessFailure = ({
  exitCode,
  stderr,
}: SourcemapProcessResult): boolean => {
  if (exitCode === 0) {
    return false;
  }

  return /(?:ECONNRESET|connection (?:reset|closed)|peer closed|TLS[^\n]*close_notify|timed? out|timeout|HTTP(?: status)?\s*5\d\d|status(?: code)?[ :=]+5\d\d|internal server error|bad gateway|service unavailable|gateway timeout)/iu.test(
    stderr,
  );
};

const retryDelayMs = (failedAttempt: number, random: () => number): number =>
  Math.round(
    INITIAL_RETRY_DELAY_MS *
      2 ** (failedAttempt - 1) *
      (RETRY_JITTER_MIN + random() * RETRY_JITTER_RANGE),
  );

export const publishSourcemapsWithRetry = async ({
  run,
  sleep,
  random,
  log,
  attempts = SOURCEMAP_UPLOAD_ATTEMPTS,
}: PublishWithRetryOptions): Promise<void> => {
  // `process` is safe to repeat: injection derives the same chunk id from the
  // same built artifact, and uploads are keyed by release plus chunk id.
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = run();
    if (result.exitCode === 0) {
      log(`Source map upload attempt ${attempt}/${attempts} succeeded.`);
      return;
    }

    const transient = isTransientSourcemapProcessFailure(result);
    if (!transient || attempt === attempts) {
      log(
        `Source map upload attempt ${attempt}/${attempts} failed${transient ? " after transient retries" : " with a non-transient error"}.`,
      );
      return panic(
        `posthog-cli sourcemap process exited with ${result.exitCode}: ${result.stderr.trim()}`,
      );
    }

    const delay = retryDelayMs(attempt, random);
    log(
      `Source map upload attempt ${attempt}/${attempts} failed transiently; retrying in ${delay}ms.`,
    );
    await sleep(delay);
  }
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
  await Promise.all(
    files.map(async (file) => {
      await rm(file);
    }),
  );
  const remaining = await listSourcemaps(root);
  if (remaining.length > 0) {
    return panic(`source maps survived removal: ${remaining.join(", ")}`);
  }
  return files.length;
};

/** Every mapped client chunk must carry the injected id, or the upload was partial. */
export const assertChunksInjected = async (
  clientRoot: string,
): Promise<number> => {
  const missing: string[] = [];
  let count = 0;
  // PostHog only injects JavaScript/source-map pairs. Vite may also copy
  // prebuilt JavaScript assets that have no map and cannot be uploaded.
  for await (const mapFile of new Bun.Glob("assets/*.js.map").scan({
    absolute: true,
    cwd: clientRoot,
  })) {
    count += 1;
    const file = mapFile.slice(0, -".map".length);
    const source = await readFile(file, "utf-8");
    if (!source.includes(CHUNK_ID_MARKER)) {
      missing.push(repoRelativePath(clientRoot, file));
    }
  }
  if (count === 0) {
    return panic("no mapped client chunks found after source-map publication");
  }
  if (missing.length > 0) {
    return panic(
      `chunks without an injected id: ${missing.toSorted().join(", ")}`,
    );
  }
  return count;
};

const publish = async (
  plan: Extract<SourcemapPublishPlan, { type: "publish" }>,
): Promise<void> => {
  const { cmd, env } = sourcemapProcessCommand(plan, CLIENT_DIST_PATH);
  await publishSourcemapsWithRetry({
    run: () => {
      const result = Bun.spawnSync(cmd, {
        env: { ...Bun.env, ...env },
        stderr: "pipe",
        stdout: "inherit",
      });
      const stderr = result.stderr.toString();
      process.stderr.write(stderr);
      return { exitCode: result.exitCode, stderr };
    },
    sleep: Bun.sleep,
    random: Math.random,
    log: console.log,
  });
};

if (import.meta.main) {
  const plan = planSourcemapPublish(Bun.env);
  if (plan.type === "publish") {
    await publish(plan);
    const injected = await assertChunksInjected(CLIENT_DIST_PATH);
    console.log(
      `Uploaded source maps for ${injected} client chunks as ${RELEASE_NAME}@${plan.version}.`,
    );
  } else {
    console.log(
      "POSTHOG_SOURCEMAP_PUBLISH is not true; maps stay unpublished.",
    );
  }
  const removed = await removeSourcemaps(DIST_PATH);
  console.log(`Removed ${removed} source map files from dist.`);
}
