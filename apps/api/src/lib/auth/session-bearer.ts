import { bearer } from "better-auth/plugins";

const BEARER_AUTHORIZATION = /^bearer\s/iu;

const usesBearer = (context: {
  request?: Request | undefined;
  headers?: Headers | undefined;
}) =>
  BEARER_AUTHORIZATION.test(
    context.request?.headers.get("authorization") ??
      context.headers?.get("authorization") ??
      "",
  );

/**
 * Session bearer support. A bearer request whose session token rotates gets
 * the new signed token in `set-auth-token`; cookie requests never see the
 * token in a readable header.
 */
export const createSessionBearer = () => {
  const plugin = bearer({ requireSignature: true });
  return {
    ...plugin,
    hooks: {
      before: plugin.hooks.before,
      after: plugin.hooks.after.map((hook) => ({
        ...hook,
        matcher: usesBearer,
      })),
    },
  };
};
