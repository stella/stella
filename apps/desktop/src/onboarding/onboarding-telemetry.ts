import {
  DESKTOP_TELEMETRY_ERROR_CODES,
  DESKTOP_TELEMETRY_OPERATIONS,
  DESKTOP_TELEMETRY_WINDOWS,
  reportDesktopError,
} from "../telemetry/desktop-telemetry";

/** Fixed codes only: setup never reports which keys were pressed. */
export const reportOnboardingFailure = () => {
  reportDesktopError({
    code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
    operation: DESKTOP_TELEMETRY_OPERATIONS.runtime,
    window: DESKTOP_TELEMETRY_WINDOWS.onboarding,
  });
};
