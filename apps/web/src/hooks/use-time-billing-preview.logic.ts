import { panic } from "better-result";

/**
 * Where a browser's request for time billing comes from. A build that ships
 * `VITE_FEATURE_TIME_BILLING` is deployed with the server flag on; a beta
 * preview (or local development) asks for a feature the server may not serve,
 * so it needs the server's answer first.
 */
export const TIME_BILLING_SOURCE = {
  build: "build",
  preview: "preview",
  none: "none",
} as const;

export type TimeBillingSource =
  (typeof TIME_BILLING_SOURCE)[keyof typeof TIME_BILLING_SOURCE];

type TimeBillingSourceInput = {
  buildEnabled: boolean;
  previewRequested: boolean;
};

export const timeBillingSource = ({
  buildEnabled,
  previewRequested,
}: TimeBillingSourceInput): TimeBillingSource => {
  if (buildEnabled) {
    return TIME_BILLING_SOURCE.build;
  }
  return previewRequested
    ? TIME_BILLING_SOURCE.preview
    : TIME_BILLING_SOURCE.none;
};

/**
 * Whether the web offers time billing. `serverEnabled` is the server's
 * `FEATURE_TIME_BILLING` answer, `undefined` while unknown; an unknown answer
 * offers nothing, so a preview never calls routes the server does not serve.
 */
export const isTimeBillingOffered = (
  source: TimeBillingSource,
  serverEnabled: boolean | undefined,
): boolean => {
  switch (source) {
    case TIME_BILLING_SOURCE.build:
      return true;
    case TIME_BILLING_SOURCE.preview:
      return serverEnabled === true;
    case TIME_BILLING_SOURCE.none:
      return false;
    default:
      source satisfies never;
      return panic(`Unknown time billing source: ${String(source)}`);
  }
};
