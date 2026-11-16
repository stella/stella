import { defineEndpoint } from "@/api/lib/endpoints";
import {
  memberSessionStreamBinding,
  sseResponse,
  subscribeUser,
} from "@/api/lib/sse";

/**
 * User-scoped SSE stream, opened through the ordinary member access: a
 * browser's cookie session (native EventSource cannot send headers), or an
 * app's access token in the `Authorization` header where `API_OAUTH_ROUTES`
 * admits it. Its events carry no content, so a client re-reads through its
 * authorized endpoints. A `?token=` credential is refused: a query-string
 * secret lands in proxy logs, referrers and history.
 *
 * The stream ends when the credential that opened it stops holding (the
 * session ends, or the token no longer authenticates on its membership).
 * It is bound to the caller's active organization for its whole life; a
 * client that switches firms opens a new one rather than having this one
 * re-point. The organization is never read off the request: the session or
 * token is the only source that may name it.
 */
const userEvents = defineEndpoint.member({}, ({ request, session, user }) => {
  if (new URL(request.url).searchParams.has("token")) {
    return new Response("Token query parameter is not supported", {
      status: 400,
    });
  }
  const binding = memberSessionStreamBinding({ session, user });
  return sseResponse(
    subscribeUser({
      organizationId: session.activeOrganizationId,
      holder: { id: session.id, kind: binding.kind },
      signal: request.signal,
      userId: user.id,
    }),
    binding,
  );
});

export default userEvents;
