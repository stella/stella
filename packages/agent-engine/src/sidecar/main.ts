import { Result } from "better-result";
import { parseArgs } from "node:util";

import { harnessEnvironment, sidecarVersion } from "./env";
import {
  HOLDER_HELLO_TIMEOUT_MS,
  HOLDER_IDLE_EXIT_MS,
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
 * `holder.log` in the folder, and keeps running when the desktop goes away;
 * see `holder.ts` for when it exits. A second start while a holder answers
 * on the endpoint exits at once.
 */

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    endpoint: { type: "string" },
  },
  strict: true,
});
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
  idleExitMs: HOLDER_IDLE_EXIT_MS,
  helloTimeoutMs: HOLDER_HELLO_TIMEOUT_MS,
  unackedRetentionMs: HOLDER_UNACKED_RETENTION_MS,
  limits: HOLDER_RUN_LIMITS,
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
