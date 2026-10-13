import { panic } from "better-result";
import { writeFileSync } from "node:fs";

const marker = process.argv.at(3) ?? panic("Missing job worker marker");
const native = process.argv.at(4) === "hard-cap";
setTimeout(() => process.exit(0), 30_000);
switch (process.argv.at(2) ?? panic("Missing job fixture mode")) {
  case "worker": {
    if (native) {
      const { dlopen, FFIType } = await import("bun:ffi");
      const library = dlopen("kernel32.dll", {
        VirtualAlloc: {
          args: [FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.u32],
          returns: FFIType.ptr,
        },
      } as const);
      // The attempted commitment is larger than the entire job cap; don't rely
      // on Bun's allocator error handling to observe the kernel's rejection.
      const allocation = library.symbols.VirtualAlloc(
        null,
        256 * 1024 ** 2,
        0x30_00,
        4,
      );
      writeFileSync(
        marker,
        allocation === null || allocation === 0n || allocation === 0
          ? "rejected"
          : "allocated",
      );
      break;
    }
    const allocation = new Uint8Array(96 * 1024 ** 2).fill(1);
    writeFileSync(marker, "ready");
    setInterval(() => {
      allocation[0] = allocation[0] === 1 ? 2 : 1;
    }, 1000);
    break;
  }
  case "launcher": {
    const worker = Bun.spawn(
      [
        process.execPath,
        import.meta.path,
        "worker",
        marker,
        ...(native ? ["hard-cap"] : []),
      ],
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
      [
        process.execPath,
        import.meta.path,
        "launcher",
        marker,
        ...(native ? ["hard-cap"] : []),
      ],
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
