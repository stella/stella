import { expect, test } from "bun:test";

test("browser initialization gates and readies validators", async () => {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "--conditions=browser",
      "-e",
      `
        import { validateIco } from "@stll/business-registries/ares";
        import {
          initialize,
          StdnumNotInitializedError,
        } from "@stll/business-registries/browser";

        let rejected = false;
        try {
          validateIco("27082440");
        } catch (error) {
          rejected = error instanceof StdnumNotInitializedError;
        }
        if (!rejected) {
          throw new Error("Expected validation to require browser initialization");
        }

        const first = initialize();
        const second = initialize();
        if (first !== second) {
          throw new Error("Expected concurrent initialization to share one promise");
        }
        await first;
        if (!validateIco("27082440")) {
          throw new Error("Expected validation to work after browser initialization");
        }
      `,
    ],
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);

  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});
