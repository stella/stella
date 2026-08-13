const SAFE_ERROR_TYPE = /^[A-Za-z][\w.-]{0,79}$/u;

export const normalizeTelemetryErrorTypeName = (candidate: string): string =>
  SAFE_ERROR_TYPE.test(candidate) ? candidate : "UnknownError";

export const telemetryErrorType = (error: unknown): string => {
  const candidate = error instanceof Error ? error.name : typeof error;
  return normalizeTelemetryErrorTypeName(candidate);
};
