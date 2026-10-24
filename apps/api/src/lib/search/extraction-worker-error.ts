const WORKER_ERROR_MARKER = "extraction-worker error: ";
const CLASS_NAME_PATTERN = /^[A-Za-z_$][\w$]*$/u;

export const formatWorkerErrorLine = (errorClass: string): string =>
  `${WORKER_ERROR_MARKER}${CLASS_NAME_PATTERN.test(errorClass) ? errorClass : "Error"}`;

export const getWorkerErrorClass = (error: unknown): string =>
  error instanceof Error && CLASS_NAME_PATTERN.test(error.name)
    ? error.name
    : "UnknownError";

export const parseWorkerErrorClass = (stderr: string): string | null => {
  const markerAt = stderr.lastIndexOf(WORKER_ERROR_MARKER);
  if (markerAt === -1) {
    return null;
  }
  const afterMarker = stderr.slice(markerAt + WORKER_ERROR_MARKER.length);
  const lineEnd = afterMarker.indexOf("\n");
  const candidate = (
    lineEnd === -1 ? afterMarker : afterMarker.slice(0, lineEnd)
  ).trim();
  return CLASS_NAME_PATTERN.test(candidate) ? candidate : null;
};
