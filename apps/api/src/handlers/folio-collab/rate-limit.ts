// Canonical matcher for the folio collaborative-edit endpoints, kept in
// sync with the `/folio-collab-sessions` prefix in ./routes.ts. The shared
// `/v1` rate limiter consults this so folio-collab traffic counts only
// against its dedicated `folioCollab` budget, never the general bucket.
const FOLIO_COLLAB_RATE_LIMIT_PATH_RE = /\/folio-collab-sessions(?:\/|$)/u;

export const isFolioCollabRateLimitedPath = (pathname: string) =>
  FOLIO_COLLAB_RATE_LIMIT_PATH_RE.test(pathname);
