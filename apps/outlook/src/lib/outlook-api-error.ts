import { TaggedError } from "better-result";

import { clearAuthToken } from "@/lib/outlook-auth";

export class OutlookAPIError extends TaggedError("OutlookAPIError")<{
  status: number;
  message: string;
}> {}

type ToAPIErrorProps = {
  status: number;
  value:
    | string
    | {
        type: "validation";
        on: string;
        summary?: string;
        message?: string;
        found?: unknown;
        property?: string;
        expected?: string;
      }
    | {
        type?: never;
        message: string;
      };
};

export const toOutlookAPIError = ({
  status,
  value,
}: ToAPIErrorProps): OutlookAPIError => {
  if (status === 401) {
    clearAuthToken();
  }

  if (typeof value === "string") {
    return new OutlookAPIError({ message: value, status });
  }

  if (value.type === "validation") {
    return new OutlookAPIError({ message: JSON.stringify(value), status });
  }

  return new OutlookAPIError({ message: value.message, status });
};

const SERVER_ERROR_THRESHOLD = 500;

export const outlookUserErrorMessage = (
  error: OutlookAPIError,
  fallback: string,
): string =>
  error.status >= SERVER_ERROR_THRESHOLD ? fallback : error.message;
