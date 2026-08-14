process.kill(process.pid, "SIGTERM");
await Bun.sleep(60_000);
