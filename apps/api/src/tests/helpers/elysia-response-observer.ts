import { panic } from "better-result";
import { Elysia } from "elysia";
import type { InternalRoute } from "elysia";

import type { ConformanceHttpResponse } from "./response-conformance-validation";

export type ElysiaResponseApp = {
  config: { aot?: boolean | undefined; strictPath?: boolean | undefined };
  routes: readonly InternalRoute[];
  router: {
    static: Readonly<Record<string, Readonly<Record<string, number>>>>;
  };
  models: Readonly<Record<string, unknown>>;
};

export type ElysiaResponseObservation = {
  app: ElysiaResponseApp;
  request: Request;
  response: ConformanceHttpResponse;
};

/** Borrows the original response; observers must leave its body to the caller. */
export type ElysiaResponseObserver = (
  observation: ElysiaResponseObservation,
) => Promise<void>;

type BeforeRequestObservation = { app: ElysiaResponseApp; request: Request };
type BeforeRequestObserver = (observation: BeforeRequestObservation) => void;
type ObserverSubscription = {
  observer: ElysiaResponseObserver;
  beforeRequest: BeforeRequestObserver | undefined;
};

const subscriptions = new Set<ObserverSubscription>();
let restorePrototype: (() => void) | undefined;

const dispatchObservation = async ({
  app,
  request,
  response,
}: ElysiaResponseObservation) => {
  // Local expectations run before an earlier process-wide conformance observer.
  for (const { observer } of Array.from(subscriptions).toReversed()) {
    await observer({ app, request, response });
  }
};

const dispatchBeforeRequest = (observation: BeforeRequestObservation) => {
  for (const { beforeRequest } of Array.from(subscriptions).toReversed()) {
    beforeRequest?.(observation);
  }
};

const unsubscribe = (subscription: ObserverSubscription) => () => {
  subscriptions.delete(subscription);
  if (subscriptions.size !== 0) {
    return;
  }
  restorePrototype?.();
  restorePrototype = undefined;
};

/**
 * Install before test apps compile; uninstall only after their requests stop.
 * Elysia's private wrap/compilation contract is checked explicitly: unsupported
 * prototype or materialized-fetch descriptors fail instead of skipping observation.
 */
export const installElysiaResponseObserver = (
  observer: ElysiaResponseObserver,
  beforeRequest?: BeforeRequestObserver,
): (() => void) => {
  const subscription = { observer, beforeRequest };
  if (restorePrototype !== undefined) {
    subscriptions.add(subscription);
    return unsubscribe(subscription);
  }
  const prototype = Elysia.prototype;
  const fetchDescriptor = Object.getOwnPropertyDescriptor(prototype, "fetch");
  const compileDescriptor = Object.getOwnPropertyDescriptor(
    prototype,
    "compile",
  );
  const originalFetch: unknown =
    fetchDescriptor === undefined
      ? undefined
      : Reflect.get(fetchDescriptor, "get");
  const originalCompile: unknown = compileDescriptor?.value;
  if (
    fetchDescriptor === undefined ||
    typeof originalFetch !== "function" ||
    fetchDescriptor.configurable !== true ||
    compileDescriptor === undefined ||
    typeof originalCompile !== "function" ||
    typeof prototype.wrap !== "function"
  ) {
    return panic("Unsupported Elysia response observer API");
  }
  const observed = new WeakSet<object>();
  const ensureObserved = (app: unknown): ElysiaResponseApp => {
    if (!(app instanceof Elysia)) {
      return panic("Elysia response observer received an invalid app");
    }
    if (observed.has(app) || app.config.aot === false) {
      return app;
    }
    app.wrap((handle: unknown) => async (request: Request) => {
      if (typeof handle !== "function") {
        return panic("Elysia response wrapper expected a handler");
      }
      dispatchBeforeRequest({ app, request });
      const pending: unknown = Reflect.apply(handle, undefined, [request]);
      const response = await pending;
      if (!(response instanceof Response)) {
        return panic("Elysia response observer expected a Response");
      }
      await dispatchObservation({ app, request, response });
      return response;
    });
    observed.add(app);
    return app;
  };
  const dynamicFetches = new WeakSet<object>();
  // Elysia's dynamic handler skips wrap; observe its materialized fetch instead.
  const observeDynamicFetch = (app: ElysiaResponseApp): void => {
    if (app.config.aot !== false) {
      return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(app, "fetch");
    if (descriptor === undefined) {
      // Native compile may leave fetch lazy; its getter will materialize it.
      return;
    }
    const fetch: unknown = descriptor.value;
    if (typeof fetch !== "function" || descriptor.configurable !== true) {
      panic("Unsupported Elysia dynamic fetch descriptor");
    }
    if (dynamicFetches.has(fetch)) {
      return;
    }
    const wrapped = new Proxy(fetch, {
      apply: async (target, thisArg: unknown, args: unknown[]) => {
        const request = args.at(0);
        if (!(request instanceof Request)) {
          return panic("Elysia response observer expected a Request");
        }
        dispatchBeforeRequest({ app, request });
        const response: unknown = await Reflect.apply(target, thisArg, args);
        if (!(response instanceof Response)) {
          return panic("Elysia response observer expected a Response");
        }
        await dispatchObservation({ app, request, response });
        return response;
      },
    });
    dynamicFetches.add(wrapped);
    Object.defineProperty(app, "fetch", { ...descriptor, value: wrapped });
  };
  Object.defineProperty(prototype, "fetch", {
    ...fetchDescriptor,
    get(this: unknown) {
      const app = ensureObserved(this);
      const fetch: unknown = Reflect.apply(originalFetch, this, []);
      if (typeof fetch !== "function") {
        return panic("Elysia fetch getter did not return a function");
      }
      observeDynamicFetch(app);
      const materialized: unknown = Object.getOwnPropertyDescriptor(
        app,
        "fetch",
      )?.value;
      if (typeof materialized !== "function") {
        return panic("Elysia fetch getter did not materialize a function");
      }
      return materialized;
    },
  });
  Object.defineProperty(prototype, "compile", {
    ...compileDescriptor,
    value: new Proxy(originalCompile, {
      apply: (target, instance: unknown, args: unknown[]) => {
        const app = ensureObserved(instance);
        const result: unknown = Reflect.apply(target, app, args);
        observeDynamicFetch(app);
        return result;
      },
    }),
  });
  restorePrototype = () => {
    Object.defineProperty(prototype, "fetch", fetchDescriptor);
    Object.defineProperty(prototype, "compile", compileDescriptor);
  };
  subscriptions.add(subscription);
  return unsubscribe(subscription);
};
