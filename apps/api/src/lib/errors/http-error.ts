/**
 * Standard HTTP error response shape.
 *
 * Every error returned to clients should use this shape so
 * the frontend can handle errors uniformly. The `code` field
 * is optional; only add it when the frontend needs to
 * distinguish between errors programmatically (e.g., show a
 * specific field error vs. a generic toast).
 */
type HttpErrorResponse = {
  message: string;
  code?: string;
};

export const httpError = (
  message: string,
  code?: string,
): HttpErrorResponse => ({
  message,
  ...(code && { code }),
});
