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

export const openInBrowser = async (url: string): Promise<boolean> => {
  const command = openCommandFor(process.platform);
  if (!command) {
    return false;
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
  const exited = new Promise<boolean>((resolve) => {
    child.on("exit", (code) => resolve(code === 0));
  });
  const errored = new Promise<boolean>((resolve) => {
    child.on("error", () => resolve(false));
  });
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), OPEN_TIMEOUT_MS);
  });

  try {
    return await Promise.race([exited, errored, timedOut]);
  } finally {
    clearTimeout(timer);
  }
};
