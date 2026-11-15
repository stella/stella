import { Result } from "better-result";
import { rmSync } from "node:fs";
import * as v from "valibot";

import { type CdpClient, type CdpMethod, createCdpClient } from "./cdp-client";
import { type CdpPipeEnd, connectCdpPipe } from "./cdp-pipe";
import {
  browserArguments,
  type BrowserProcesses,
  type BrowserProfile,
  clearOrphan,
  spawnBrowser,
  writeInstance,
} from "./launch";

/**
 * One running stella browser: its process, the protocol client over its
 * pipe, and how it ends. A process exit or the pipe's end marks it gone;
 * the holder starts another on the next `open`.
 */

/** From this version on, Chrome honours the debugging pipe only on a profile of its own. */
const MIN_BROWSER_MAJOR = 136;

const VERSION_TIMEOUT_MS = 20_000;
const CLOSE_WAIT_MS = 5000;
const TERM_WAIT_MS = 5000;

export type BrowserInstance = {
  client: CdpClient;
  /** The browser's own name and version, as it reports it. */
  product: string;
  /** Its main process. */
  pid: number;
  /** Settles once the browser is gone, whatever ended it. */
  gone: Promise<CdpPipeEnd | { type: "exited" }>;
  isGone: () => boolean;
  /** Asks the browser to close (it flushes cookies), then ends the process. */
  close: () => Promise<void>;
};

export type StartFailure =
  | { type: "in-use" }
  | { type: "did-not-start" }
  | { type: "too-old"; product: string }
  | { type: "no-answer" };

/** The major version in a product string such as `Chrome/146.0.7680.80`. */
const MAJOR_VERSION = v.pipe(v.string(), v.digits(), v.toNumber());

const productMajor = (product: string): number | null => {
  const major = v.safeParse(MAJOR_VERSION, /\/(\d{1,4})\./u.exec(product)?.[1]);
  return major.success ? major.output : null;
};

const exitedWithin = async (
  exited: Promise<unknown>,
  ms: number,
): Promise<boolean> =>
  await Promise.race([
    exited.then(() => true),
    Bun.sleep(ms).then(() => false),
  ]);

export const startBrowserInstance = async ({
  environment,
  executable,
  onMethod,
  processes,
  profile,
  testArgs,
  errorLog = null,
}: {
  environment: Record<string, string>;
  executable: string;
  /** Each protocol method as it is sent, for the test hooks. */
  onMethod?: (method: CdpMethod) => void;
  processes: BrowserProcesses;
  profile: BrowserProfile;
  testArgs: readonly string[];
  /** Where the browser's error output goes; nowhere unless the test hooks name a file. */
  errorLog?: string | null;
}): Promise<Result<BrowserInstance, StartFailure>> => {
  const orphan = await clearOrphan({ processes, profile });
  if (orphan.type === "in-use") {
    return Result.err({ type: "in-use" });
  }
  const launched = await spawnBrowser({
    args: browserArguments({ profileDir: profile.profileDir, testArgs }),
    environment,
    errorLog,
    executable,
  });
  if (Result.isError(launched)) {
    return Result.err({ type: "did-not-start" });
  }
  const { child, input, output, pid } = launched.value;
  writeInstance(profile.instanceFile, {
    browserPid: pid,
    holderPid: process.pid,
  });
  const exited = new Promise<{ type: "exited" }>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ type: "exited" });
      return;
    }
    child.once("exit", () => {
      resolve({ type: "exited" });
    });
  });
  // The client answers what the pipe reads; the pipe carries what it sends.
  const inbox = { receive: (_json: string): void => undefined };
  const pipe = connectCdpPipe(
    { input, output },
    {
      onMessage: (json) => {
        inbox.receive(json);
      },
    },
  );
  const client = createCdpClient(
    { send: (json) => pipe.send(json) },
    onMethod === undefined ? {} : { onSend: onMethod },
  );
  inbox.receive = client.receive;
  /** Ends the process: SIGTERM, then SIGKILL, each given time to take. */
  const terminate = async () => {
    if (await exitedWithin(exited, 0)) {
      return;
    }
    processes.signal(pid, "SIGTERM");
    if (await exitedWithin(exited, TERM_WAIT_MS)) {
      return;
    }
    processes.signal(pid, "SIGKILL");
    await exited;
  };
  let gone = false;
  // However it ends, the instance is gone only once its process is: a pipe
  // that ended or overflowed leaves a browser that cannot be driven, so it
  // is ended rather than left running.
  const ended = Promise.race([pipe.ended, exited]).then(async (end) => {
    gone = true;
    pipe.close();
    client.disconnect();
    await terminate();
    rmSync(profile.instanceFile, { force: true });
    return end;
  });
  const close = async () => {
    if (!gone) {
      const asked = await client.send(
        "Browser.close",
        {},
        { timeoutMs: CLOSE_WAIT_MS },
      );
      // A browser that took the request closes by itself; one that did not
      // is ended when the pipe closes below.
      if (Result.isOk(asked)) {
        await exitedWithin(exited, CLOSE_WAIT_MS);
      }
    }
    pipe.close();
    await ended;
  };
  const version = await client.send(
    "Browser.getVersion",
    {},
    { timeoutMs: VERSION_TIMEOUT_MS },
  );
  if (Result.isError(version)) {
    await close();
    return Result.err({ type: "no-answer" });
  }
  const major = productMajor(version.value.product);
  if (major === null || major < MIN_BROWSER_MAJOR) {
    await close();
    return Result.err({ product: version.value.product, type: "too-old" });
  }
  const discovering = await client.send("Target.setDiscoverTargets", {
    discover: true,
  });
  // Until downloads go to the run's folder as the extension's do, a page
  // in the stella browser downloads nothing.
  const downloads = Result.isOk(discovering)
    ? await client.send("Browser.setDownloadBehavior", { behavior: "deny" })
    : discovering;
  if (Result.isError(downloads)) {
    await close();
    return Result.err({ type: "no-answer" });
  }
  return Result.ok({
    client,
    close,
    gone: ended,
    isGone: () => gone,
    pid,
    product: version.value.product,
  });
};
