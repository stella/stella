export type ResponseConformanceObservation = {
  handler: object;
  config: { response?: unknown };
  context: unknown;
  result: unknown;
};

export type ResponseConformanceObserver = (
  observation: ResponseConformanceObservation,
) => void | Promise<void>;

let responseConformanceObserver: ResponseConformanceObserver | undefined;

/** Configure before importing handler modules so their factories capture it. */
export const setResponseConformanceObserver = (
  observer: ResponseConformanceObserver | undefined,
): (() => void) => {
  const previous = responseConformanceObserver;
  responseConformanceObserver = observer;
  return () => {
    responseConformanceObserver = previous;
  };
};

/** Observe outside the handler's error boundary; observer failures must escape. */
export const observeHandlerResponses = <THandler extends object>(
  handler: THandler,
  config: { response?: unknown },
): THandler => {
  const observer = responseConformanceObserver;
  if (observer === undefined || typeof handler !== "function") {
    return handler;
  }
  return new Proxy(handler, {
    apply: async (target, thisArg: unknown, args: unknown[]) => {
      const result: unknown = await Reflect.apply(target, thisArg, args);
      await observer({
        handler: target,
        config,
        context: args.at(0),
        result,
      });
      return result;
    },
  });
};
