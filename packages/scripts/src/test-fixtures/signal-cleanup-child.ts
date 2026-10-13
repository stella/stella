import { writeFileSync } from "node:fs";

import {
  exitFixtureLeader,
  spawnWindowsFixtureProcess,
} from "./native-fixture-process";

const marker = process.argv.at(2);
if (marker === undefined) {
  process.exit(2);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => writeFileSync(marker, signal));
}
// The fixture remains bounded even if shutdown escalation is removed.
setTimeout(() => process.exit(0), 30_000);
if (process.argv.at(3) === "leaf") {
  console.log("ready");
} else {
  if (process.platform === "win32" && process.argv.at(3) === "leader-exit") {
    const workerPid = await spawnWindowsFixtureProcess([
      import.meta.path,
      `${marker}.grandchild`,
      "leaf",
    ]);
    console.log(workerPid);
    await exitFixtureLeader();
  }
  const grandchild = Bun.spawn(
    [process.execPath, import.meta.path, `${marker}.grandchild`, "leaf"],
    { stdout: "pipe", stderr: "inherit" },
  );
  if (process.argv.at(3) === "leader-exit") {
    console.log(grandchild.pid);
    await exitFixtureLeader();
  }
  await grandchild.stdout.getReader().read();
  console.log(grandchild.pid);
}
