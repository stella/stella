import {
  type DESKTOP_TELEMETRY_ERROR_CODES,
  type DESKTOP_TELEMETRY_OPERATIONS,
  DESKTOP_TELEMETRY_WINDOWS,
  reportDesktopError,
} from "../telemetry/desktop-telemetry";

export const reportActivityError = (
  operation: (typeof DESKTOP_TELEMETRY_OPERATIONS)[
    "activityRead" | "activitySubscribe" | "activityUpdate"],
  code: (typeof DESKTOP_TELEMETRY_ERROR_CODES)[
    "eventSubscriptionFailed" | "invalidResponse" | "invokeFailed"],
) => {
  // Fixed codes only: nothing about what was recorded leaves the window.
  reportDesktopError({
    code,
    operation,
    window: DESKTOP_TELEMETRY_WINDOWS.activity,
  });
};
