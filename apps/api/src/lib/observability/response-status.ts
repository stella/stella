import type { Context } from "elysia";
import { ElysiaCustomStatusResponse } from "elysia/error";

const DEFAULT_RESPONSE_STATUS = 200;

type ResolveResponseStatusOptions = {
  response: unknown;
  set: Context["set"];
};

/**
 * The status a reply is actually sent with, as seen from `onAfterHandle`.
 *
 * A handler can carry its status on the value it returns rather than on
 * `set`: `status(code, body)` holds it on the returned wrapper, and a
 * returned `Response` holds it on the response itself. Elysia applies
 * either while mapping the response, which happens after `onAfterHandle`
 * runs, so `set.status` still holds the default at that point. Reading
 * `set` alone therefore reports every such reply as a 200, including the
 * whole safe-handler error path and any upstream status a route forwards
 * verbatim.
 */
export const resolveResponseStatus = ({
  response,
  set,
}: ResolveResponseStatusOptions): number => {
  // `code` is generic over the status the call site passed, so it only
  // narrows to a number once the instance is checked.
  if (
    response instanceof ElysiaCustomStatusResponse &&
    typeof response.code === "number"
  ) {
    return response.code;
  }

  if (response instanceof Response) {
    return response.status;
  }

  return typeof set.status === "number" ? set.status : DEFAULT_RESPONSE_STATUS;
};
