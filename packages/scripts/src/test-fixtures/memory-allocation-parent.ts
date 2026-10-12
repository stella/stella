const child = Bun.spawn(
  [process.execPath, `${import.meta.dir}/memory-allocation.ts`],
  {
    stdout: "ignore",
    stderr: "inherit",
  },
);
await child.exited;
