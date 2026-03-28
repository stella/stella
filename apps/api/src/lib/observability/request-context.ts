type RequestContext = {
  startTime: number;
  posthogDistinctId?: string;
  organizationId?: string;
  sessionId?: string;
};

const requestContextStore = new WeakMap<Request, RequestContext>();

export const initRequestContext = (
  request: Request,
  sessionId?: string,
): void => {
  const context: RequestContext = {
    startTime: performance.now(),
  };

  if (sessionId) {
    context.sessionId = sessionId;
  }

  requestContextStore.set(request, context);
};

export const enrichRequestContext = (
  request: Request,
  update: Partial<Omit<RequestContext, "startTime">>,
): void => {
  const current = requestContextStore.get(request);
  if (!current) {
    return;
  }

  Object.assign(current, update);
};

export const getRequestContext = (
  request: Request,
): RequestContext | undefined => requestContextStore.get(request);
