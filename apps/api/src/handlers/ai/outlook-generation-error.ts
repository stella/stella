import { HandlerError } from "@/api/lib/errors/tagged-errors";

const isHandlerError = (cause: unknown): cause is HandlerError =>
  cause instanceof HandlerError;

export const toOutlookGenerationError = (
  cause: unknown,
  fallbackMessage: string,
): HandlerError => {
  if (isHandlerError(cause)) {
    return cause;
  }
  return new HandlerError({
    status: 502,
    message: fallbackMessage,
    cause,
  });
};
