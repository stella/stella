import { harnessEnvironment, sidecarVersion } from "./env";
import { SidecarHost } from "./host";
import {
  encodeSidecarMessage,
  parseSidecarHostLine,
  SIDECAR_MAX_LINE_BYTES,
  type SidecarMessage,
} from "./protocol";

/**
 * The harness sidecar the desktop app spawns: `bun build --compile` turns this
 * file into `stella-agent-sidecar-<target triple>`, and debug builds run it
 * with `bun` directly. The protocol is on stdin and stdout (`protocol.ts`);
 * stderr is a log the desktop records. Closing stdin stops every run and
 * exits, so the sidecar never outlives the app that spawned it.
 */

const log = (line: string) => {
  process.stderr.write(`${line}\n`);
};
const send = (message: SidecarMessage) => {
  const line = encodeSidecarMessage(message);
  if (line === null) {
    log(`dropped an oversized ${message.type} message`);
    return;
  }
  process.stdout.write(line);
};

const host = new SidecarHost({
  sidecarVersion: sidecarVersion(),
  send,
  log,
  environment: harnessEnvironment(),
});

/** Feed complete lines to the host until it is done or stdin closes. */
const readHost = async () => {
  const decoder = new TextDecoder();
  let buffer = "";
  /** Discarding the rest of a line that already exceeded the limit. */
  let skipping = false;
  for await (const bytes of Bun.stdin.stream()) {
    buffer += decoder.decode(bytes, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (skipping) {
        skipping = false;
        continue;
      }
      if (line.trim() === "") {
        continue;
      }
      const parsed = parseSidecarHostLine(line);
      if (parsed.type === "rejected") {
        host.reject(parsed.reason, parsed.messageType, null);
        continue;
      }
      if (!host.handle(parsed.message)) {
        return;
      }
    }
    if (buffer.length > SIDECAR_MAX_LINE_BYTES) {
      host.reject("too_large", null, null);
      buffer = "";
      skipping = true;
    }
  }
};

await readHost();
await host.shutdown();
await new Promise((resolve) => {
  process.stdout.write("", resolve);
});
process.exit(0);
