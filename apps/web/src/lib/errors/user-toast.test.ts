import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";
import { stellaToast } from "@stll/ui/toast";

import { getAnalytics } from "@/lib/analytics/provider";
import { toAPIError } from "@/lib/errors/api";
import {
  detachedUserAction,
  notifyUserError,
  resetUserErrorReportDedupeForTests,
} from "@/lib/errors/user-toast";

const FAILURE = "That did not work";

/** Let the detached rejection handler run. */
const settle = async () => {
  await sleep(0);
};

afterEach(() => {
  resetUserErrorReportDedupeForTests();
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
      feature: "web",
      routeTemplate: "unknown",
      type: "user-visible",
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

describe("notifyUserError", () => {
  test("reports a visible error once with explicit route metadata", () => {
    const capture = spyOn(getAnalytics(), "captureError").mockImplementation(
      () => undefined,
    );
    spyOn(stellaToast, "add").mockReturnValue("failure-toast");
    const failure = new Error("private detail");

    notifyUserError(failure, FAILURE, {
      feature: "auth",
      routeTemplate: "/auth/error",
    });
    notifyUserError(failure, FAILURE, {
      feature: "auth",
      routeTemplate: "/auth/error",
    });

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(failure, {
      feature: "auth",
      routeTemplate: "/auth/error",
      type: "user-visible",
    });
  });

  test("reports an admission refusal while keeping its own notice", () => {
    const capture = spyOn(getAnalytics(), "captureError").mockImplementation(
      () => undefined,
    );
    const add = spyOn(stellaToast, "add").mockReturnValue("refusal-toast");
    const refusal = toAPIError({
      status: 403,
      value: { code: "action_not_enabled", message: "private detail" },
    });

    expect(notifyUserError(refusal, FAILURE)).toBe(false);

    expect(capture).toHaveBeenCalledTimes(1);
    expect(add.mock.calls.at(0)?.at(0)).toMatchObject({
      id: "action_not_enabled",
      type: "info",
    });
  });
});
