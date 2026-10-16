import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";
import { stellaToast } from "@stll/ui/toast";

import { MatterStewardHandoverContent } from "@/components/matter-steward-handover-content";
import { getAnalytics } from "@/lib/analytics/provider";
import { toAPIError } from "@/lib/errors/api";
import { detachedUserAction, notifyUserError } from "@/lib/errors/user-toast";

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

test("handover refusal toast presents authorized matters as corrective links", () => {
  const add = spyOn(stellaToast, "add").mockReturnValue("handover-toast");
  const affectedMatters = [
    { id: "00000000-0000-4000-8000-000000000001", name: "Matter A" },
  ];
  const error = toAPIError({
    status: 409,
    value: {
      code: "matter_steward_handover_required",
      message: "Transport wording",
      affectedMatters,
    },
  });
  notifyUserError(error, FAILURE);
  expect(add.mock.calls.at(0)?.[0]).toMatchObject({
    title: error.message,
    description: {
      type: MatterStewardHandoverContent,
      props: { matters: affectedMatters },
    },
    type: "error",
  });
});
