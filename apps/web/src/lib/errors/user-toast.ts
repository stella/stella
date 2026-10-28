import { createElement } from "react";

import { Result } from "better-result";

import { copyToClipboard } from "@stll/clipboard";
import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { createDetached } from "@stll/errors";
import { stellaToast } from "@stll/ui/toast";

import { ProviderDiagnosticToast } from "@/components/provider-diagnostic-content";
import { getTranslator } from "@/i18n/translator";
import { notifyStepUp } from "@/lib/account/mcp-step-up";
import { telemetryErrorType } from "@/lib/analytics/error-diagnostics";
import { getAnalytics } from "@/lib/analytics/provider";
import { resetReportedErrorsForTests } from "@/lib/analytics/reported-error";
import { BoundedSet } from "@/lib/bounded-set";
import type { DetachedOperationId } from "@/lib/detached";
import { actionAdmissionOutcome } from "@/lib/errors/action-admission";
import { APIError, isCancellation } from "@/lib/errors/api";
import { toAuthClientError } from "@/lib/errors/auth";
import { providerDiagnosticFromThrown } from "@/lib/errors/provider-diagnostic";
import { userErrorFromThrown } from "@/lib/errors/user-safe";

type UserErrorToastOptions = Omit<
  Parameters<typeof stellaToast.add>[0],
  "title" | "type"
> & {
  feature?: string | undefined;
  occurrence?: string | number | undefined;
  routeTemplate?: string | undefined;
  toastId?: string | undefined;
};

type ProblemToastOptions = Omit<
  UserErrorToastOptions,
  "feature" | "occurrence" | "routeTemplate"
>;

/**
 * A user-facing error names its cause. A cause that is always `undefined` or
 * `null` is a cause-free message, which goes through
 * {@link notifyUserProblem}; a cause that may be missing is reported only when
 * it is there (see {@link notifyUserError}).
 */
type NamedCause<Cause> = [Cause] extends [undefined | null] ? never : unknown;

type UserVisibleErrorReportOptions = {
  notice?: string | undefined;
  occurrence?: string | number | undefined;
};

let currentRouteTemplate = "unknown";
const REPORTED_ERROR_LIMIT = 1000;
const reportedFingerprints = new BoundedSet<string>(REPORTED_ERROR_LIMIT);
const reportedApiErrorsWithoutNotice = new BoundedSet<string>(
  REPORTED_ERROR_LIMIT,
);

export const resetUserErrorReportDedupeForTests = (): void => {
  reportedFingerprints.clear();
  reportedApiErrorsWithoutNotice.clear();
  resetReportedErrorsForTests();
};

const featureFromRoute = (routeTemplate: string): string => {
  if (routeTemplate === "unknown") {
    return "web";
  }
  const feature = routeTemplate.split("/").find((part) => part !== "");
  return feature?.replace(/^_protected\.?/u, "") || "web";
};

export const setUserErrorRouteTemplate = (routeTemplate: string): void => {
  currentRouteTemplate = routeTemplate;
};

/** Report a user-visible failure by its cause; without one there is nothing to report. */
export const reportUserVisibleError = (
  error: unknown,
  feature: string | undefined,
  routeTemplate: string | undefined,
  { notice, occurrence }: UserVisibleErrorReportOptions = {},
): void => {
  if (error === undefined || error === null) {
    return;
  }
  const reportable = error;
  const template =
    (routeTemplate ?? currentRouteTemplate).split(/[?#]/u).at(0) ?? "unknown";
  const isApiError = APIError.is(error);
  const apiIdentity = isApiError
    ? `${error.status}:${error.code ?? "unknown"}`
    : "not-api";
  const noticeIdentity =
    notice ??
    actionAdmissionOutcome(error)?.messageKey ??
    userErrorFromThrown(error, "user-visible");
  const occurrenceIdentity =
    occurrence === undefined ? "default" : `${typeof occurrence}:${occurrence}`;
  const fingerprint = [
    noticeIdentity,
    template,
    telemetryErrorType(reportable),
    apiIdentity,
    occurrenceIdentity,
  ].join("|");
  const apiOccurrence = [
    template,
    telemetryErrorType(reportable),
    apiIdentity,
    occurrenceIdentity,
  ].join("|");
  if (reportedFingerprints.has(fingerprint)) {
    return;
  }
  if (
    notice !== undefined &&
    isApiError &&
    reportedApiErrorsWithoutNotice.delete(apiOccurrence)
  ) {
    reportedFingerprints.add(fingerprint);
    return;
  }
  reportedFingerprints.add(fingerprint);
  if (notice === undefined && isApiError) {
    reportedApiErrorsWithoutNotice.add(apiOccurrence);
  }
  getAnalytics().captureError(reportable, {
    fingerprintKey: "reportUserVisibleError:failure",
    scope: { type: "request", method: "GET", routeTemplate: template },
    context: {
      type: "user-visible",
      routeTemplate: template,
      feature: feature ?? featureFromRoute(template),
    },
  });
};

/**
 * Tell the user about a problem that has no error behind it: input a form
 * refuses, a limit, a precondition. Nothing is reported, because there is no
 * cause to report; a failure with one goes through {@link notifyUserError}.
 */
export const notifyUserProblem = (
  title: string,
  { toastId, ...options }: ProblemToastOptions = {},
): void => {
  const toast = { ...options, title, type: "error" } as const;
  if (toastId !== undefined) {
    stellaToast.update(toastId, toast);
    return;
  }
  stellaToast.add(toast);
};

export const notifyUserError = <Cause>(
  error: Cause & NamedCause<Cause>,
  fallback: string,
  {
    feature,
    occurrence,
    routeTemplate,
    toastId,
    ...options
  }: UserErrorToastOptions = {},
): boolean => {
  // An optional cause that is missing leaves a message with nothing behind it.
  if (error === undefined || error === null) {
    notifyUserProblem(fallback, { ...options, toastId });
    return true;
  }
  if (isCancellation(error)) {
    return false;
  }
  if (notifyStepUp(error)) {
    return false;
  }
  // The stable refusal id coalesces the API client's observer and local error
  // handlers; raw fetch and SDK errors also need to emit the same notice here.
  const refusal = actionAdmissionOutcome(error);
  const title = userErrorFromThrown(error, fallback);
  reportUserVisibleError(error, feature, routeTemplate, {
    notice: refusal?.messageKey ?? title,
    occurrence,
  });
  if (refusal) {
    const t = getTranslator();
    stellaToast.add({
      id: refusal.code,
      title: t(refusal.messageKey),
      type: "info",
      ...(refusal.contactUrl
        ? {
            description: createElement(
              "a",
              {
                className: "underline underline-offset-4",
                href: sanitizeHref(refusal.contactUrl),
                rel: "noreferrer",
                target: "_blank",
              },
              t("errors.actionAdmission.contact"),
            ),
          }
        : {}),
    });
    if (toastId !== undefined) {
      stellaToast.close(toastId);
    }
    return false;
  }
  const diagnostic = providerDiagnosticFromThrown(error);
  const toast = {
    ...options,
    title:
      diagnostic === undefined
        ? title
        : createElement(ProviderDiagnosticToast, {
            diagnostic,
            onCopy: async () => {
              const copied = await copyToClipboard(
                `${diagnostic.provider}: ${diagnostic.message}`,
              );
              if (Result.isError(copied)) {
                notifyUserError(
                  copied.error,
                  getTranslator()("errors.actionFailed"),
                );
                return false;
              }
              return true;
            },
          }),
    type: "error",
  } as const;
  if (toastId !== undefined) {
    stellaToast.update(toastId, toast);
    return true;
  }
  stellaToast.add(toast);
  return true;
};

const SERVER_ERROR_THRESHOLD = 500;

export const notifyAuthClientError = (
  error: Parameters<typeof toAuthClientError>[0],
  fallback: string,
) =>
  notifyUserError(toAuthClientError(error), fallback, {
    description:
      error.status < SERVER_ERROR_THRESHOLD
        ? (error.message ?? fallback)
        : fallback,
  });

type DetachedUserActionOptions = {
  /** A fixed label for telemetry, as `detached` takes. */
  context: DetachedOperationId;
  /** What the person is told when the action fails. */
  failureMessage: string;
};

/**
 * Run work a person started with a press, without awaiting it. Unlike
 * `detached`, a rejection is shown as well as reported: a press must never
 * end in nothing.
 */
export const detachedUserAction = (
  operation: unknown,
  { context, failureMessage }: DetachedUserActionOptions,
): void => {
  createDetached((error) => {
    notifyUserError(error, failureMessage);
  })(operation, context);
};
