import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";
import { stellaToast } from "@stll/ui/toast";

import { getAnalytics } from "@/lib/analytics/provider";
import { reportErrorOnce } from "@/lib/analytics/reported-error";
import { toAPIError } from "@/lib/errors/api";
import {
  detachedUserAction,
  notifyUserError,
  notifyUserProblem,
  resetUserErrorReportDedupeForTests,
} from "@/lib/errors/user-toast";

const FAILURE = "That did not work";

/**
 * The reports this module makes. Other work in the process may report through
 * the same analytics singleton, so assertions count only user-visible reports.
 */
const userVisibleReports = (capture: {
  mock: { calls: readonly (readonly unknown[])[] };
}) =>
  capture.mock.calls.filter(([, options]) => {
    if (
      typeof options !== "object" ||
      options === null ||
      !("context" in options)
    ) {
      return false;
    }
    const { context } = options;
    return (
      typeof context === "object" &&
      context !== null &&
      "type" in context &&
      context.type === "user-visible"
    );
  });

/** Let the detached rejection handler run. */
const settle = async () => {
  await sleep(0);
};

afterEach(() => {
  resetUserErrorReportDedupeForTests();
  mock.restore();
});

describe("notifyUserProblem", () => {
  test("shows the problem and reports nothing, having no cause", () => {
    const capture = spyOn(getAnalytics(), "captureError").mockImplementation(
      () => undefined,
    );
    const add = spyOn(stellaToast, "add").mockReturnValue("problem-toast");

    notifyUserProblem(FAILURE, { description: "Check the date." });

    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls.at(0)?.[0]).toMatchObject({
      title: FAILURE,
      description: "Check the date.",
      type: "error",
    });
    expect(userVisibleReports(capture)).toEqual([]);
  });

  test("replaces the toast it is given", () => {
    const update = spyOn(stellaToast, "update").mockImplementation(
      () => undefined,
    );
    const add = spyOn(stellaToast, "add").mockReturnValue("problem-toast");

    notifyUserProblem(FAILURE, { toastId: "upload-progress" });

    expect(add).not.toHaveBeenCalled();
    expect(update.mock.calls.at(0)?.[0]).toBe("upload-progress");
  });
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
      fingerprintKey: "reportUserVisibleError:failure",
      scope: { type: "request", method: "GET", routeTemplate: "unknown" },
      context: {
        feature: "web",
        routeTemplate: "unknown",
        type: "user-visible",
      },
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

    expect(userVisibleReports(capture)).toEqual([]);
    expect(add).not.toHaveBeenCalled();
  });
});

describe("notifyUserError", () => {
  test("accepts caught unknowns and errors as causes", () => {
    spyOn(getAnalytics(), "captureError").mockImplementation(() => undefined);
    const add = spyOn(stellaToast, "add").mockReturnValue("failure-toast");
    const caught: unknown = new Error("caught");

    notifyUserError(caught, FAILURE);
    notifyUserError(new Error("plain"), FAILURE);

    expect(add).toHaveBeenCalledTimes(2);
  });

  test("aborted fetch errors are neither shown nor reported", () => {
    const capture = spyOn(getAnalytics(), "captureError").mockImplementation(
      () => undefined,
    );
    const add = spyOn(stellaToast, "add").mockReturnValue("failure-toast");
    const abort = new DOMException("Cancelled", "AbortError");
    const error = toAPIError({
      status: 0,
      value: null,
      kind: "aborted",
      cause: abort,
    });

    expect(notifyUserError(error, FAILURE)).toBe(false);
    expect(notifyUserError(abort, FAILURE)).toBe(false);
    expect(userVisibleReports(capture)).toEqual([]);
    expect(add).not.toHaveBeenCalled();
  });

  test("a missing optional cause shows the message and reports nothing", () => {
    const capture = spyOn(getAnalytics(), "captureError").mockImplementation(
      () => undefined,
    );
    const add = spyOn(stellaToast, "add").mockReturnValue("failure-toast");
    const optional = (cause: Error | undefined) => {
      notifyUserError(cause, FAILURE, { description: "Try again." });
    };

    optional(undefined);
    optional(new Error("refused"));

    expect(add).toHaveBeenCalledTimes(2);
    expect(add.mock.calls.at(0)?.[0]).toMatchObject({
      title: FAILURE,
      description: "Try again.",
      type: "error",
    });
    expect(userVisibleReports(capture)).toHaveLength(1);
  });

  test("reports two different notices of one cause", () => {
    const capture = spyOn(getAnalytics(), "captureError").mockImplementation(
      () => undefined,
    );
    spyOn(stellaToast, "add").mockReturnValue("failure-toast");
    const failure = new Error("save refused");

    notifyUserError(failure, "First notice");
    notifyUserError(failure, "Second notice");

    expect(userVisibleReports(capture)).toHaveLength(2);
  });

  test("reports the same notice of one cause once", () => {
    const capture = spyOn(getAnalytics(), "captureError").mockImplementation(
      () => undefined,
    );
    spyOn(stellaToast, "add").mockReturnValue("failure-toast");
    const failure = new Error("save refused");

    notifyUserError(failure, FAILURE);
    notifyUserError(failure, FAILURE);

    expect(userVisibleReports(capture)).toHaveLength(1);
  });

  test("reports the same notice once per occurrence", () => {
    const capture = spyOn(getAnalytics(), "captureError").mockImplementation(
      () => undefined,
    );
    spyOn(stellaToast, "add").mockReturnValue("failure-toast");
    const failure = new Error("save refused");

    notifyUserError(failure, FAILURE, { occurrence: "first" });
    notifyUserError(failure, FAILURE, { occurrence: "first" });
    notifyUserError(failure, FAILURE, { occurrence: "second" });

    expect(userVisibleReports(capture)).toHaveLength(2);
  });

  test("does not report a boundary error again at the root", () => {
    const capture = spyOn(getAnalytics(), "captureError").mockImplementation(
      () => undefined,
    );
    const failure = new Error("render failed");
    const report = (error: unknown) =>
      capture(error, {
        fingerprintKey: "notifyUserError:boundary",
        scope: { type: "handler", handlerId: "notifyUserError:boundary" },
      });

    reportErrorOnce(failure, report);
    reportErrorOnce(failure, report);

    expect(
      capture.mock.calls.filter(([reported]) => reported === failure),
    ).toHaveLength(1);
  });

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

    expect(userVisibleReports(capture)).toHaveLength(1);
    expect(capture).toHaveBeenCalledWith(failure, {
      fingerprintKey: "reportUserVisibleError:failure",
      scope: { type: "request", method: "GET", routeTemplate: "/auth/error" },
      context: {
        feature: "auth",
        routeTemplate: "/auth/error",
        type: "user-visible",
      },
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

    expect(userVisibleReports(capture)).toHaveLength(1);
    expect(add.mock.calls.at(0)?.at(0)).toMatchObject({
      id: "action_not_enabled",
      type: "info",
    });
  });
});

// A user-facing error names its cause; a message with none is a problem notice.
const missingCauseContract = () => {
  // @ts-expect-error no cause: use notifyUserProblem for a message with nothing to report
  notifyUserError(undefined, FAILURE);
  // @ts-expect-error a null cause is no cause either
  notifyUserError(null, FAILURE);
};
void missingCauseContract;
