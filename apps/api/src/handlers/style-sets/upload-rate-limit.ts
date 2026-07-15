const STYLE_SET_CREATE_PATH_RE = /\/style-sets\/?$/u;
const STYLE_SET_REPLACE_PATH_RE = /\/style-sets\/[^/]+\/source\/?$/u;
const STYLE_SET_EDITOR_CREATE_PATH_RE = /\/style-sets\/editor\/?$/u;
const STYLE_SET_EDITOR_UPDATE_PATH_RE = /\/style-sets\/[^/]+\/editor\/?$/u;

export const isStyleSetUploadRateLimitedRequest = (
  request: Pick<Request, "method" | "url">,
): boolean => {
  const { pathname } = new URL(request.url);
  if (request.method === "PUT") {
    return (
      STYLE_SET_CREATE_PATH_RE.test(pathname) ||
      STYLE_SET_EDITOR_CREATE_PATH_RE.test(pathname)
    );
  }
  return (
    request.method === "POST" &&
    (STYLE_SET_REPLACE_PATH_RE.test(pathname) ||
      STYLE_SET_EDITOR_UPDATE_PATH_RE.test(pathname))
  );
};
