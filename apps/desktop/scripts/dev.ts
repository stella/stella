import { resolve } from "node:path";

const cwd = resolve(import.meta.dir, "..");

const children = [
  Bun.spawn(["bun", "run", "dev:view"], {
    cwd,
    stderr: "inherit",
    stdout: "inherit",
  }),
  Bun.spawn(["bun", "run", "dev:app"], {
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

const exitCode = await Promise.race(
  children.map(async (child) => await child.exited),
);

await shutdown(exitCode);
