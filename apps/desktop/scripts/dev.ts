import { resolve } from "node:path";

import { resolveDesktopViewPort } from "../src/dev-config";

const cwd = resolve(import.meta.dir, "..");
const DESKTOP_VIEW_URL = `http://127.0.0.1:${String(resolveDesktopViewPort(process.env))}`;

const waitForDesktopView = async (timeoutMs = 30_000) => {
  const startedAt = Date.now();
  let lastFailure = "desktop view did not respond yet";

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(DESKTOP_VIEW_URL, {
        method: "GET",
        signal: AbortSignal.timeout(1500),
      });
      const body = await response.text();

      if (
        response.ok &&
        body.includes("<title>stella desktop</title>") &&
        body.includes('id="root"')
      ) {
        return;
      }

      lastFailure = `unexpected response status ${String(response.status)}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }

    await Bun.sleep(250);
  }

  throw new Error(`Timed out waiting for desktop view: ${lastFailure}`);
};

const children = [
  Bun.spawn(["bun", "run", "dev:view"], {
    cwd,
    stderr: "inherit",
    stdout: "inherit",
  }),
];

let shuttingDown = false;

const shutdown = async (exitCode: number) => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of children) {
    child.kill();
  }

  await Promise.all(
    children.map(async (child) => await child.exited.catch(() => 1)),
  );
  process.exit(exitCode);
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(0);
  });
}

try {
  await waitForDesktopView();

  children.push(
    Bun.spawn(["bun", "run", "dev:app"], {
      cwd,
      stderr: "inherit",
      stdout: "inherit",
    }),
  );

  const exitCode = await Promise.race(
    children.map(async (child) => await child.exited),
  );

  await shutdown(exitCode);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  await shutdown(1);
}
