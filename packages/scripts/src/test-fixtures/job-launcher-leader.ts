import { panic } from "better-result";
import { writeFileSync } from "node:fs";

const marker = process.argv.at(3) ?? panic("Missing job worker marker");
setTimeout(() => process.exit(0), 30_000);
switch (process.argv.at(2) ?? panic("Missing job fixture mode")) {
  case "worker": {
    const allocation = new Uint8Array(96 * 1024 ** 2).fill(1);
    writeFileSync(marker, "ready");
    setInterval(() => {
      allocation[0] = allocation[0] === 1 ? 2 : 1;
    }, 1000);
    break;
  }
  case "launcher": {
    const worker = Bun.spawn(
      [process.execPath, import.meta.path, "worker", marker],
      {
        stdout: "ignore",
        stderr: "inherit",
      },
    );
    console.log(worker.pid);
    process.exit(0);
  }
  case "leader":
  case "leader-exit": {
    const launcher = Bun.spawn(
      [process.execPath, import.meta.path, "launcher", marker],
      {
        stdout: "pipe",
        stderr: "inherit",
      },
    );
    const worker = (await new Response(launcher.stdout).text()).trim();
    await launcher.exited;
    while (!(await Bun.file(marker).exists())) {
      await Bun.sleep(10);
    }
    console.log(`${launcher.pid} ${worker}`);
    if (process.argv.at(2) === "leader-exit") {
      process.exit(0);
    }
    break;
  }
  default:
    panic("Missing job fixture mode");
}
