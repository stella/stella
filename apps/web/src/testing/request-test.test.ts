import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";
import { withTestTmpDir } from "@stll/test-kit";

import { runInRequest } from "@/testing/request-test";

test("a request assertion rejects with its original message", async () => {
  const error = await rejectionOf(
    runInRequest(() => {
      expect("request-scenario-actual").toBe("request-scenario-expected");
    }),
  );
  expect(error).toMatchObject({
    message: expect.stringContaining("request-scenario-expected"),
  });
});

test("an asynchronous request assertion rejects outside the HTTP boundary", async () => {
  const error = await rejectionOf(
    runInRequest(async () => {
      await Promise.resolve();
      expect("async-scenario-actual").toBe("async-scenario-expected");
    }),
  );
  expect(error).toMatchObject({
    message: expect.stringContaining("async-scenario-expected"),
  });
});

test.each([undefined, null, "non-Error rejection"])(
  "preserves the original request rejection value: %j",
  async (rejection) => {
    expect(
      await rejectionOf(
        runInRequest(() => {
          // oxlint-disable-next-line typescript/only-throw-error -- Non-Error values are the request-boundary rejection cases under test.
          throw rejection;
        }),
      ),
    ).toBe(rejection);
  },
);

test("successful request scenarios settle after asynchronous work", async () => {
  const calls: string[] = [];
  await runInRequest(async () => {
    calls.push("started");
    await Promise.resolve();
    calls.push("finished");
  });
  expect(calls).toEqual(["started", "finished"]);
});

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
