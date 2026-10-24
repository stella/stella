/** Statuses whose answer never carries a body, so `status(204)` sends none. */
const BODILESS_STATUS = new Set([101, 204, 205, 304, 307, 308]);

/** Reason phrases, as Node's `STATUS_CODES` spells them, for this API's statuses. */
const REASON_PHRASES = new Map([
  [400, "Bad Request"],
  [401, "Unauthorized"],
  [403, "Forbidden"],
  [404, "Not Found"],
  [405, "Method Not Allowed"],
  [409, "Conflict"],
  [410, "Gone"],
  [413, "Payload Too Large"],
  [415, "Unsupported Media Type"],
  [422, "Unprocessable Entity"],
  [429, "Too Many Requests"],
  [500, "Internal Server Error"],
  [502, "Bad Gateway"],
  [503, "Service Unavailable"],
  [504, "Gateway Timeout"],
]);

/**
 * A handler answer that carries its own status: `return status(404, { message })`.
 *
 * Without a body the answer is the status text (`status(404)` sends
 * "Not Found"), except for the bodiless statuses above.
 */
export class HttpStatusResponse<
  const TCode extends number = number,
  const TBody = unknown,
> {
  readonly code: TCode;
  readonly response: TBody;

  constructor(code: TCode, response: TBody) {
    this.code = code;
    this.response = response;
  }
}

type DefaultBody<TCode extends number> = TCode extends 204 | 205 | 304
  ? undefined
  : string;

export function status<const TCode extends number>(
  code: TCode,
): HttpStatusResponse<TCode, DefaultBody<TCode>>;
export function status<const TCode extends number, const TBody>(
  code: TCode,
  response: TBody,
): HttpStatusResponse<TCode, TBody>;
export function status(code: number, response?: unknown) {
  if (BODILESS_STATUS.has(code)) {
    return new HttpStatusResponse(code, undefined);
  }
  return new HttpStatusResponse(
    code,
    response === undefined
      ? (REASON_PHRASES.get(code) ?? String(code))
      : response,
  );
}

/** The innermost value and effective status of a possibly nested answer. */
export const unwrapStatus = (
  value: unknown,
): { value: unknown; code: number | undefined } => {
  let current = value;
  let code: number | undefined;
  while (current instanceof HttpStatusResponse) {
    code = current.code;
    current = current.response;
  }
  return { value: current, code };
};
