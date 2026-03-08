import { env } from "@/api/env";

/**
 * Redirect a verification code to the frontend verify route.
 *
 * The server only validates the code format; actual resolution
 * (code → workspace/entity) happens on the frontend via an
 * authenticated API call. This avoids leaking internal IDs
 * (workspaceId, entityId) in the unauthenticated redirect.
 */
export const resolveVerificationCode = (code: string) => {
  const frontendUrl = env.FRONTEND_URL;
  const target = `${frontendUrl}/verify/${encodeURIComponent(code)}`;

  return new Response(null, {
    status: 302,
    headers: { Location: target },
  });
};
