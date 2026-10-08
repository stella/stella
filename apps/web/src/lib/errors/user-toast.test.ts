import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";
import { stellaToast } from "@stll/ui/toast";

import { getAnalytics } from "@/lib/analytics/provider";
import { detachedUserAction } from "@/lib/errors/user-toast";

const FAILURE = "That did not work";

/** Let the detached rejection handler run. */
const settle = async () => {
  await sleep(0);
};

afterEach(() => {
  mock.restore();
});

describe("detachedUserAction", () => {
  test("a failed press is reported and shown", async () => {
    const capture = spyOn(getAnalytics(), "captureError").mockImplementation(
      () => undefined,
    );
    const add = spyOn(stellaToast, "add").mockReturnValue("failure-toast");
    const failure = new Error("navigation refused");

    detachedUserAction(Promise.reject(failure), {
      context: "test.press",
      failureMessage: FAILURE,
    });
    await settle();

    expect(capture).toHaveBeenCalledWith(failure, {
      type: "detached",
      operation: "test.press",
    });
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls.at(0)?.[0]).toMatchObject({ type: "error" });
  });

  test("a press that succeeds stays quiet", async () => {
    const capture = spyOn(getAnalytics(), "captureError").mockImplementation(
      () => undefined,
    );
    const add = spyOn(stellaToast, "add").mockReturnValue("failure-toast");

    detachedUserAction(Promise.resolve(), {
      context: "test.press",
      failureMessage: FAILURE,
    });
    await settle();

    expect(capture).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });
});
