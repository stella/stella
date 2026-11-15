import { Result } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { runNativeHost } from "./browser/native-host";
import {
  extraBrowserExtensionIds,
  harnessEnvironment,
  homeFolder,
  protocolLogSetting,
  sidecarVersion,
} from "./env";
import {
  HOLDER_HELLO_TIMEOUT_MS,
  HOLDER_IDLE_EXIT_MS,
  HOLDER_PROCESS_GRANT_TIMEOUT_MS,
  HOLDER_RUN_LIMITS,
  HOLDER_UNACKED_RETENTION_MS,
} from "./holder";
import { startHolderServer } from "./holder-server";

/**
 * The harness sidecar: `bun build --compile` turns this file into
 * `stella-agent-sidecar-<target triple>`, and debug builds run it with `bun`
 * directly. The desktop starts it detached, as the holder of its runs:
 *
 *   stella-agent-sidecar --dir <version folder> --endpoint <socket or pipe>
 *
 * It serves the protocol (`protocol.ts`) on the endpoint and logs to
 * `holder.log` in the folder, with the protocol log when the environment
 * turns it on (`env.ts`), and keeps running when the desktop goes away;
 * see `holder.ts` for when it exits. A second start while a holder answers
 * on the endpoint exits at once.
 *
 * Chrome starts it as the stella extension's native messaging host, through
 * the script the holder registers (`browser/native-host-manifest.ts`):
 *
 *   stella-agent-sidecar --native-host --browser-endpoint <socket>
 *     --browser-secret-file <file> <caller origin>
 */

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    endpoint: { type: "string" },
    "native-host": { type: "boolean" },
    "browser-endpoint": { type: "string" },
    "browser-secret-file": { type: "string" },
  },
  // Chrome passes the calling extension's origin.
  allowPositionals: true,
  strict: true,
});

/** Retries a holder that is not there yet, while Chrome keeps the host. */
const NATIVE_HOST_RETRY_MS = 2000;

if (values["native-host"] === true) {
  const endpoint = values["browser-endpoint"];
  const secretFile = values["browser-secret-file"];
  if (endpoint === undefined || secretFile === undefined) {
    process.stderr.write(
      "usage: stella-agent-sidecar --native-host --browser-endpoint <socket> --browser-secret-file <file>\n",
    );
    process.exit(2);
  }
  const secret = Result.try(() => readFileSync(secretFile, "utf-8").trim());
  if (Result.isError(secret)) {
    process.exit(1);
  }
  await runNativeHost({
    endpoint,
    input: process.stdin,
    output: (frame) => {
      process.stdout.write(frame);
    },
    retryMs: NATIVE_HOST_RETRY_MS,
    secret: secret.value,
  });
  process.exit(0);
}

if (values.dir === undefined || values.endpoint === undefined) {
  process.stderr.write(
    "usage: stella-agent-sidecar --dir <folder> --endpoint <socket>\n",
  );
  process.exit(2);
}

const started = await startHolderServer({
  dir: values.dir,
  endpoint: values.endpoint,
  sidecarVersion: sidecarVersion(),
  environment: harnessEnvironment(),
  protocolLog: protocolLogSetting(),
  idleExitMs: HOLDER_IDLE_EXIT_MS,
  helloTimeoutMs: HOLDER_HELLO_TIMEOUT_MS,
  unackedRetentionMs: HOLDER_UNACKED_RETENTION_MS,
  processGrantTimeoutMs: HOLDER_PROCESS_GRANT_TIMEOUT_MS,
  limits: HOLDER_RUN_LIMITS,
  browser: {
    // A compiled sidecar's entry point is inside its executable; in
    // development Bun runs this file.
    command: existsSync(Bun.main)
      ? [process.execPath, Bun.main]
      : [process.execPath],
    extraExtensionIds: extraBrowserExtensionIds(),
    home: homeFolder(),
    platform: process.platform,
  },
});
if (Result.isError(started)) {
  process.exit(started.error.reason === "already_running" ? 0 : 1);
}
const server = started.value;
// A session ending (logout) stops the runs instead of orphaning harnesses.
process.once("SIGTERM", () => {
  server.holder.stop();
});
await server.exited;
process.exit(0);
