const STYLE_SET_CREATE_PATH_RE = /\/style-sets\/?$/u;
const STYLE_SET_REPLACE_PATH_RE = /\/style-sets\/[^/]+\/source\/?$/u;

export const isStyleSetUploadRateLimitedRequest = (
  request: Pick<Request, "method" | "url">,
): boolean => {
  const { pathname } = new URL(request.url);
  if (request.method === "PUT") {
    return STYLE_SET_CREATE_PATH_RE.test(pathname);
  }
  return request.method === "POST" && STYLE_SET_REPLACE_PATH_RE.test(pathname);
};
