// Passive regression fixture for
// `require-toast-error-capture/require-toast-error-capture`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses, the matching disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails CI. The
// allowed cases carry no disable, so a false positive would fail the fixture
// too.

declare const stellaToast: {
  (title: string): string;
  add: (options: { title: string; type?: string }) => string;
  error: (title: string) => string;
  info: (title: string) => string;
  update: (id: string, options: { title?: string; type?: string }) => void;
};
declare const analytics: {
  captureError: (error: unknown) => void;
};
declare const getAnalytics: () => { captureError: (error: unknown) => void };
declare const risky: () => Promise<void>;
declare const toAPIError: (error: unknown) => Error;
declare const logSomething: (error: unknown) => void;
declare const toastId: string;

type FakeResult = { error: unknown; isErr: () => boolean };
declare const runResult: () => Promise<FakeResult>;

// MUST flag: paramless catch raising an error toast.
const unboundCatch = async () => {
  try {
    await risky();
    // oxlint-disable-next-line require-toast-error-capture/require-toast-error-capture
  } catch {
    stellaToast.error("Something went wrong");
  }
};

// MUST flag: bound error that never reaches capture.
const uncapturedCatch = async () => {
  try {
    await risky();
    // oxlint-disable-next-line require-toast-error-capture/require-toast-error-capture
  } catch (error) {
    stellaToast.error(String(error));
  }
};

// MUST flag: paramless promise `.catch` callback raising an error toast.
const unboundPromiseCatch = async () => {
  // oxlint-disable-next-line require-toast-error-capture/require-toast-error-capture
  await risky().catch(() => {
    stellaToast.error("Something went wrong");
  });
};

// MUST flag: `stellaToast.add({ type: "error" })` is an error toast too.
const unboundAddCatch = async () => {
  try {
    await risky();
    // oxlint-disable-next-line require-toast-error-capture/require-toast-error-capture
  } catch {
    stellaToast.add({ title: "Something went wrong", type: "error" });
  }
};

// MUST flag: `stellaToast.update(id, { type: "error" })` likewise.
const unboundUpdateCatch = async () => {
  try {
    await risky();
    // oxlint-disable-next-line require-toast-error-capture/require-toast-error-capture
  } catch {
    stellaToast.update(toastId, { type: "error" });
  }
};

// MUST flag: an `isErr()` branch that toasts and drops the typed error.
const uncapturedResult = async () => {
  const result = await runResult();
  // oxlint-disable-next-line require-toast-error-capture/require-toast-error-capture
  if (result.isErr()) {
    stellaToast.error("Something went wrong");
  }
};

// --- Cases the rule MUST NOT flag ---

// Bound and captured through the analytics hook value.
const capturedCatch = async () => {
  try {
    await risky();
  } catch (error) {
    analytics.captureError(error);
    stellaToast.error("Something went wrong");
  }
};

// Captured through the module-level accessor, wrapped on the way in.
const capturedPromiseCatch = async () => {
  await risky().catch((error: unknown) => {
    getAnalytics().captureError(toAPIError(error));
    stellaToast.error("Something went wrong");
  });
};

// The `isErr()` branch captures the typed error before toasting.
const capturedResult = async () => {
  const result = await runResult();
  if (result.isErr()) {
    analytics.captureError(result.error);
    stellaToast.error("Something went wrong");
  }
};

// Not an error toast.
const infoToastCatch = async () => {
  try {
    await risky();
  } catch {
    stellaToast.info("Working offline");
  }
};

// `stellaToast.add` without an error type.
const neutralAddCatch = async () => {
  try {
    await risky();
  } catch {
    stellaToast.add({ title: "Working offline" });
  }
};

// No toast at all: the handler's obligations are elsewhere.
const noToastCatch = async () => {
  try {
    await risky();
  } catch (error) {
    logSomething(error);
  }
};

// A nested handler owns its own toast: the outer handler must not be
// reported for a toast it does not raise. The outer catch is deliberately
// paramless, so a walk that failed to stop at the nested `.catch` would
// report it.
const nestedHandlerCatch = async () => {
  try {
    await risky();
  } catch {
    await risky().catch((error: unknown) => {
      analytics.captureError(error);
      stellaToast.error("Something went wrong");
    });
  }
};

export const __requireToastErrorCaptureFixture = {
  unboundCatch,
  uncapturedCatch,
  unboundPromiseCatch,
  unboundAddCatch,
  unboundUpdateCatch,
  uncapturedResult,
  capturedCatch,
  capturedResult,
  capturedPromiseCatch,
  infoToastCatch,
  neutralAddCatch,
  noToastCatch,
  nestedHandlerCatch,
};
