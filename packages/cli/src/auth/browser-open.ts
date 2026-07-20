// Best-effort system-browser launch. Never throws: the printed URL is always
// the fallback (see `login.ts`), so a failure here is not fatal. Uses
// `node:child_process` `spawn` so the published CLI runs under plain Node.

import { spawn } from "node:child_process";

const OPEN_TIMEOUT_MS = 5000;

export const openCommandFor = (
  platform: NodeJS.Platform,
): readonly string[] | undefined => {
  if (platform === "darwin") {
    return ["open"];
  }
  if (platform === "win32") {
    return ["explorer.exe"];
  }
  return ["xdg-open"];
};

/**
 * Outcome of a launch attempt.
 *
 * Deliberately three states rather than a boolean: "the opener did not settle
 * within the timeout" is NOT the same as "there is no browser". A slow desktop
 * portal or an `xdg-open` that only exits once the browser closes both land in
 * `unknown`, and the browser is very likely opening anyway — so callers must
 * keep waiting on the loopback redirect there, and may only fall back to a
 * manual paste on a definite `failed`.
 */
export type BrowserLaunch = {
  readonly status: "opened" | "failed" | "unknown";
};

const LAUNCH_OPENED: BrowserLaunch = { status: "opened" };
const LAUNCH_FAILED: BrowserLaunch = { status: "failed" };
const LAUNCH_UNKNOWN: BrowserLaunch = { status: "unknown" };

export const openInBrowser = async (url: string): Promise<BrowserLaunch> => {
  const command = openCommandFor(process.platform);
  if (!command) {
    return LAUNCH_FAILED;
  }

  // `command` always has at least one element (see `openCommandFor`); append
  // the URL as the final argument, matching the old `[...command, url]` spawn.
  const [file, ...args] = [...command, url];

  // Detached + `stdio: "ignore"` decouples the launched browser from the CLI
  // (the old `Bun.spawn` ignored all three streams too); a bound `error`
  // handler keeps an async spawn failure (ENOENT) from throwing on the emitter.
  const child = spawn(file, args, { detached: true, stdio: "ignore" });
  // Drop the child from the parent's event loop reference count so a slow or
  // GUI-detaching opener can never keep the CLI alive after login completes;
  // the `exit`/`error` listeners below still settle the race while we wait.
  child.unref();

  // Mirror the old logic: succeed on a zero exit code, fail on a spawn error,
  // and bound the wait so a hung opener can never stall the CLI. Each executor
  // resolves exactly once; `Promise.race` takes whichever settles first.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<BrowserLaunch>((resolve) => {
    child.on("exit", (code) =>
      resolve(code === 0 ? LAUNCH_OPENED : LAUNCH_FAILED),
    );
  });
  const errored = new Promise<BrowserLaunch>((resolve) => {
    child.on("error", () => resolve(LAUNCH_FAILED));
  });
  const timedOut = new Promise<BrowserLaunch>((resolve) => {
    timer = setTimeout(() => resolve(LAUNCH_UNKNOWN), OPEN_TIMEOUT_MS);
  });

  try {
    return await Promise.race([exited, errored, timedOut]);
  } finally {
    clearTimeout(timer);
  }
};
