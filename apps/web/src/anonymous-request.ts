/**
 * A request is anonymous when it carries no credentials: no cookie (the
 * session and every presentation preference live in cookies) and no
 * authorization header. What the server renders for it depends only on its
 * URL and language, never on a viewer.
 */
export const isAnonymousRequest = (request: Request): boolean =>
  !request.headers.has("cookie") && !request.headers.has("authorization");
