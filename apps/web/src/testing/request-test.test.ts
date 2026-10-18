import { expect, test } from "bun:test";

import { withTestTmpDir } from "@stll/test-kit";

// Exercise the registered test, not just its runner: a framework-generated HTTP
// error must never turn a failed assertion into a successful Bun test process.
test("requestTest fails the registered test when its scenario assertion fails", async () => {
  await withTestTmpDir(async (directory) => {
    const fixture = directory.join("scenario.test.ts");
    const helper = new URL("request-test.ts", import.meta.url).href;
    await Bun.write(
      fixture,
      `import { expect } from "bun:test";
import { requestTest } from ${JSON.stringify(helper)};
requestTest("scenario assertion", () => {
  expect("registered-scenario-actual").toBe("registered-scenario-expected");
});
`,
    );
    const result = Bun.spawn(["bun", "test", fixture], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      result.exited,
      new Response(result.stderr).text(),
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("registered-scenario-expected");
    expect(stderr).toContain("1 fail");
  }, "request-test-failure");
});
