export const ENTITY_UPLOAD_ROUTE_PATHS = {
  entity: "/upload",
  generatedDocument: "/upload-generated-document",
  version: "/upload-version",
} as const;

const UPLOAD_ROUTE_NAMES = new Set(
  Object.values(ENTITY_UPLOAD_ROUTE_PATHS).map((path) => path.slice(1)),
);

const ENTITY_ACTION_PATH_RE = /\/entities\/[^/]+\/([^/]+)\/?$/u;

export const isUploadRateLimitedPath = (pathname: string): boolean => {
  const action = ENTITY_ACTION_PATH_RE.exec(pathname)?.[1];
  return action !== undefined && UPLOAD_ROUTE_NAMES.has(action);
};

const TRANSLATE_RATE_LIMIT_PATH_RE = /\/entities\/[^/]+\/translate\/?$/u;

export const isTranslateRateLimitedPath = (pathname: string) =>
  TRANSLATE_RATE_LIMIT_PATH_RE.test(pathname);
