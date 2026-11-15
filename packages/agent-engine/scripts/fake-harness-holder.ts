import { Result } from "better-result";

import { createDetached } from "@stll/errors";

import { startHarnessProcess } from "../src/harness/harness-process";
import { PROTOCOL_LOG_OFF } from "../src/protocol-log";

/**
 * A holder that starts one harness process and never ends it, for a test to
 * kill outright, as a crash would end the sidecar. Writes `ready` once the
 * harness says it is up.
 *
 * Usage: `bun scripts/fake-harness-holder.ts <fake CLI script> <scenario> <log>`.
 */

const [cli, scenario, log] = process.argv.slice(2);
if (cli === undefined || scenario === undefined || log === undefined) {
  process.stderr.write(
    "usage: fake-harness-holder.ts <fake CLI script> <scenario> <log>\n",
  );
  process.exit(2);
}

const started = startHarnessProcess<number, Error>({
  command: [process.execPath, cli, scenario],
  cwd: process.cwd(),
  env: { FAKE_HARNESS_LOG: log, PATH: process.env["PATH"] ?? "" },
  detached: createDetached((error) => {
    process.stderr.write(`${String(error)}\n`);
  }),
  deadlines: { requestMs: 60_000, terminateMs: 300 },
  name: "fake-holder",
  protocol: { channel: "codex", log: PROTOCOL_LOG_OFF },
  unanswered: (_reason, message) => new Error(message),
  message: (value) => {
    if (
      typeof value === "object" &&
      value !== null &&
      "method" in value &&
      value.method === "fake/ready"
    ) {
      process.stdout.write("ready\n");
    }
  },
  violation: () => undefined,
  exit: () => undefined,
});
if (Result.isError(started)) {
  process.stderr.write(`${started.error.message}\n`);
  process.exit(1);
}
