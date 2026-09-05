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

// A bilingual layout and a translation run share one budget: each turns a
// stored file into a new document, and a translation run also spends the
// organisation's paid character quota with the provider.
const BILINGUAL_PATH_RE = /\/entities\/[^/]+\/bilingual\/?$/u;
const TRANSLATION_RUN_START_PATH_RE = /\/document-translations\/runs\/?$/u;

export const isTranslateRateLimitedPath = (pathname: string) =>
  BILINGUAL_PATH_RE.test(pathname) ||
  TRANSLATION_RUN_START_PATH_RE.test(pathname);
