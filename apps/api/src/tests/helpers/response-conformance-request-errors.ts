import { rethrowResponseConformanceError } from "@/api/lib/response-conformance-error";

const failures = new WeakMap<Request, unknown>();

/** Keep the defect available after framework error handling converts a thrown response. */
export const recordResponseConformanceFailure = (
  request: Request,
  error: unknown,
): void => {
  failures.set(request, error);
};

export const rethrowResponseConformanceFailure = (request: Request): void => {
  const error = failures.get(request);
  failures.delete(request);
  rethrowResponseConformanceError(error);
};

const requestModels = new WeakMap<Request, Readonly<Record<string, unknown>>>();

export const setResponseConformanceRequestModels = (
  request: Request,
  models: Readonly<Record<string, unknown>>,
): void => {
  requestModels.set(request, models);
};

export const getResponseConformanceRequestModels = (
  request: Request,
): Readonly<Record<string, unknown>> | undefined => requestModels.get(request);
