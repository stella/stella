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
  let value = response;
  let selectedStatus = set.status;
  // Each status wrapper replaces set.status before Elysia maps its payload.
  while (
    value instanceof ElysiaCustomStatusResponse &&
    typeof value.code === "number"
  ) {
    selectedStatus = value.code;
    value = value.response;
  }

  if (value instanceof Response && value.status !== DEFAULT_RESPONSE_STATUS) {
    return value.status;
  }

  if (typeof selectedStatus === "number") {
    return selectedStatus;
  }

  if (typeof selectedStatus === "string") {
    return StatusMap[selectedStatus];
  }

  return DEFAULT_RESPONSE_STATUS;
};
