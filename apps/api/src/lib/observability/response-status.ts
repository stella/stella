import { StatusMap, type Context } from "elysia";
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
 * returned `Response` holds it on the response itself, except that a raw
 * 200 lets `set.status` override it. Elysia applies this while mapping the
 * response, after `onAfterHandle` runs. Reading `set` alone therefore loses
 * status wrappers and non-200 raw responses, including safe-handler errors.
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

  // Elysia's raw-response mapper lets an explicit set.status override a 200
  // Response; other raw statuses retain their own status.
  if (
    response instanceof Response &&
    response.status !== DEFAULT_RESPONSE_STATUS
  ) {
    return response.status;
  }

  if (typeof set.status === "number") {
    return set.status;
  }

  if (typeof set.status === "string") {
    return StatusMap[set.status];
  }

  return DEFAULT_RESPONSE_STATUS;
};
