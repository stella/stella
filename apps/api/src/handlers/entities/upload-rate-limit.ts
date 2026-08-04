const UPLOAD_RATE_LIMIT_PATH_RE =
  /\/entities\/[^/]+\/(?:upload|upload-generated-document|upload-version)\/?$/u;

export const isUploadRateLimitedPath = (pathname: string) =>
  UPLOAD_RATE_LIMIT_PATH_RE.test(pathname);

const TRANSLATE_RATE_LIMIT_PATH_RE = /\/entities\/[^/]+\/translate\/?$/u;

export const isTranslateRateLimitedPath = (pathname: string) =>
  TRANSLATE_RATE_LIMIT_PATH_RE.test(pathname);
