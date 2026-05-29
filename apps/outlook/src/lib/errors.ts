import { TaggedError } from "better-result";

export class APIError extends TaggedError("ApiError")<{
  status: number;
  message: string;
}>() {}

export class OutlookError extends TaggedError("OutlookError")<{
  message: string;
}>() {}

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

export const toAPIError = ({ status, value }: ToAPIErrorProps): APIError => {
  if (typeof value === "string") {
    return new APIError({ message: value, status });
  }

  if (value.type === "validation") {
    return new APIError({ message: JSON.stringify(value), status });
  }

  return new APIError({ message: value.message, status });
};

const SERVER_ERROR_THRESHOLD = 500;

export const userErrorMessage = (error: APIError, fallback: string): string =>
  error.status >= SERVER_ERROR_THRESHOLD ? fallback : error.message;
