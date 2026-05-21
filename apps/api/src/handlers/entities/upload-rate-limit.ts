const UPLOAD_RATE_LIMIT_PATH_RE =
  /\/entities\/[^/]+\/(?:upload|upload-version)\/?$/u;

export const isUploadRateLimitedPath = (pathname: string) =>
  UPLOAD_RATE_LIMIT_PATH_RE.test(pathname);
