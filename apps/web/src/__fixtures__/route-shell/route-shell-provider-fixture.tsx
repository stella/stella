import type { ComponentType, LazyExoticComponent } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { plugin } from "bun";
import { afterAll, expect, test } from "bun:test";
import * as v from "valibot";

import { parseTimeZoneId } from "@stll/time";

import { routeSearchRefusals } from "@/__fixtures__/route-shell/route-search-totality";
import {
  authFixtureBeforeLoadData,
  authFixtureLoaderData,
  authFixtureResponse,
} from "@/__fixtures__/route-shell/route-shell-auth-fixtures";
import {
  knowledgeFixtureResponse,
  knowledgeFixtureLoaderData,
  knowledgeFixtureReadyText,
  KNOWLEDGE_FIXTURE_TOOL_SLUG,
} from "@/__fixtures__/route-shell/route-shell-knowledge-fixtures";
import {
  publicFixtureLoaderData,
  publicFixtureResponse,
  publicFixtureReadyText,
  publicFixtureReadySelector,
  publicRouteExceptions,
} from "@/__fixtures__/route-shell/route-shell-public-fixtures";
import type { api } from "@/lib/api";
import type { AuthenticatedUser } from "@/lib/authenticated-user-context";
import { sessionOptions } from "@/lib/auth-query-options";
import { defaultPresentationPrefs } from "@/lib/account/presentation-prefs/preferences";
import { toSafeId } from "@/lib/safe-id";
import { unregisterDomEnvironment } from "@/test-dom-environment";

type RouteShellProviderFixtureOptions = {
  mode: "public-knowledge" | "legacy-tools";
  suite?: "leaf-shells" | "law-hosts" | "professional-use" | "route-search";
  /** The router's reading of a URL, which the route-search suite checks with. */
  parseSearch?: (searchStr: string) => Record<string, unknown>;
};

const FIXTURE_AUDIENCE = { anonymous: "anonymous", member: "member" } as const;
type FixtureAudience = (typeof FIXTURE_AUDIENCE)[keyof typeof FIXTURE_AUDIENCE];
const LAW_SCENARIO = { ...FIXTURE_AUDIENCE, undeclared: "undeclared" } as const;
const fixtureRouteSchema = v.object({
  id: v.string(),
  fullPath: v.string(),
  parentRoute: v.optional(v.object({ id: v.string() })),
  options: v.looseObject({
    component: v.optional(
      v.custom<ComponentType | LazyExoticComponent<ComponentType>>(
        (value) =>
          typeof value === "function" ||
          (typeof value === "object" && value !== null),
      ),
    ),
    loader: v.optional(v.unknown()),
    validateSearch: v.optional(v.unknown()),
    staticData: v.optional(
      v.looseObject({
        appFrame: v.optional(v.picklist(["none", "member", "knowledge"])),
      }),
    ),
  }),
  update: v.custom<(options: Record<string, unknown>) => void>(
    (value) => typeof value === "function",
  ),
});
type FixtureRoute = v.InferOutput<typeof fixtureRouteSchema>;
const setupFixtureEnvironment = (
  mode: RouteShellProviderFixtureOptions["mode"],
) => {
  GlobalRegistrator.register({ url: "http://localhost:3000/law" });
  Object.assign(import.meta.env, {
    DEV: true,
    VITE_PUBLIC_LAW_ENABLED: "true",
    VITE_PUBLIC_KNOWLEDGE_ENABLED:
      mode === "public-knowledge" ? "true" : "false",
    VITE_PUBLIC_TOOLS_ENABLED: "true",
  });

  // Vite emits worker imports as URLs; shell rendering never starts these workers.
  plugin({
    name: "route-shell-worker-url",
    setup(build) {
      build.onLoad({ filter: /\?worker&url$/u }, () => ({
        contents: 'export default "/worker.js";',
        loader: "js",
      }));
    },
  });
  for (const name of ["__APP_VERSION__", "__APP_COMMIT_SHA__"]) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: "test",
    });
  }
};
// Resolve EventTarget after Happy DOM installs its matching Event constructor.
const createFixtureEventSource = () =>
  class FixtureEventSource extends EventTarget implements EventSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readonly url: string;
    readonly withCredentials: boolean;
    readyState = 1;
    onerror: EventSource["onerror"] = null;
    onmessage: EventSource["onmessage"] = null;
    onopen: EventSource["onopen"] = null;
    private readonly eventListeners = new Map<unknown, EventListener>();
    constructor(url: string | URL, init: EventSourceInit = {}) {
      super();
      this.url = String(url);
      this.withCredentials = init.withCredentials ?? false;
      const path = new URL(this.url, window.location.origin).pathname;
      if (
        path !== "/v1/workspaces/00000000-0000-4000-8000-000000000001/events"
      ) {
        panic(`Unrecorded shell event stream: ${path}`);
      }
      queueMicrotask(() => {
        if (this.readyState === 1) {
          this.dispatchEvent(new Event("open"));
        }
      });
    }
    close() {
      this.readyState = 2;
    }
    override addEventListener<K extends keyof EventSourceEventMap>(
      type: K,
      listener: (this: EventSource, event: EventSourceEventMap[K]) => unknown,
      options?: boolean | AddEventListenerOptions,
    ): void;
    override addEventListener(
      type: string,
      listener: (this: EventSource, event: MessageEvent) => unknown,
      options?: boolean | AddEventListenerOptions,
    ): void;
    override addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void;
    override addEventListener(
      type: string,
      listener: unknown,
      options?: boolean | AddEventListenerOptions,
    ) {
      super.addEventListener(
        type,
        eventListener(this.eventListeners, listener, this),
        options,
      );
    }
    override removeEventListener<K extends keyof EventSourceEventMap>(
      type: K,
      listener: (this: EventSource, event: EventSourceEventMap[K]) => unknown,
      options?: boolean | EventListenerOptions,
    ): void;
    override removeEventListener(
      type: string,
      listener: (this: EventSource, event: MessageEvent) => unknown,
      options?: boolean | EventListenerOptions,
    ): void;
    override removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ): void;
    override removeEventListener(
      type: string,
      listener: unknown,
      options?: boolean | EventListenerOptions,
    ) {
      super.removeEventListener(
        type,
        eventListener(this.eventListeners, listener, this),
        options,
      );
    }
  };

const eventListener = (
  listeners: Map<unknown, EventListener>,
  listener: unknown,
  target: EventSource,
) => {
  const existing = listeners.get(listener);
  if (existing !== undefined) {
    return existing;
  }
  const wrapped: EventListener = (event) => {
    if (typeof listener === "function") {
      Reflect.apply(listener, target, [event]);
      return;
    }
    if (
      typeof listener === "object" &&
      listener !== null &&
      "handleEvent" in listener &&
      typeof listener.handleEvent === "function"
    ) {
      Reflect.apply(listener.handleEvent, listener, [event]);
    }
  };
  listeners.set(listener, wrapped);
  return wrapped;
};

const settleFixtureRequest = async () => {
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
};

const installFixtureNetwork = () => {
  const originalFetch = globalThis.fetch;
  const originalWindowClose = window.close;
  window.close = () => {
    /* Keep the popup fixture alive until its assertions finish. */
  };
  const unexpectedRequests: string[] = [];
  const requests: string[] = [];
  const state: { audience: FixtureAudience } = {
    audience: FIXTURE_AUDIENCE.anonymous,
  };
  const professionalUseState: { status: "accepted" | "required" } = {
    status: "accepted",
  };
  const user = {
    id: "user-fixture",
    email: "member@example.test",
    name: "Fixture member",
    image: null,
    preferredName: null,
    timezoneId: "UTC",
    wordEditShortcut: null,
  } satisfies Omit<AuthenticatedUser, "activeOrganizationId">;
  const session = {
    userId: toSafeId<"user">(user.id),
    activeOrganizationId: toSafeId<"organization">("org-fixture"),
  };
  const originalEventSource = globalThis.EventSource;
  globalThis.EventSource = createFixtureEventSource();
  const timeZone = parseTimeZoneId("UTC");
  if (timeZone === null) {
    panic("UTC must be a supported fixture time zone");
  }
  const organizationSettings = {
    declaredFeatureIds: [],
    deploymentFeatures: { legalLists: true },
    capabilities: {},
    documentProcessingMode: "off",
    matterNumberPattern: "{year}/{number}",
    matterNumberPadding: 3,
    matterNumberingEnabled: true,
    practiceJurisdictions: [],
    promptCachingEnabled: true,
    managedAIResidency: "eu",
    memoryExtractionEnabled: false,
    timeMinimumUnitMinutes: 1,
    timeEditWindowDays: 30,
    timeLockedThroughMonth: null,
    timeNarrativeRequired: false,
    timeZone,
    timeZoneSource: "organization",
  } satisfies NonNullable<
    Awaited<ReturnType<(typeof api)["organization-settings"]["get"]>>["data"]
  >;
  const workspace = {
    id: toSafeId<"workspace">("00000000-0000-4000-8000-000000000001"),
    organizationId: session.activeOrganizationId,
    name: "Fixture matter",
    reference: "2026/1",
    clientId: null,
    leadUserId: null,
    billingReference: null,
    color: null,
    status: "active",
    lastActivityAt: "2026-10-01T00:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
    client: null,
    stampedVersionCount: 0,
  } satisfies NonNullable<
    Awaited<ReturnType<ReturnType<typeof api.workspaces>["get"]>>["data"]
  >;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      await settleFixtureRequest();
      const url = input instanceof Request ? input.url : String(input);
      const pathname = new URL(url, window.location.origin).pathname;
      requests.push(pathname);
      if (pathname === "/api/auth/get-session") {
        return Response.json(
          state.audience === "member" ? { session, user } : null,
        );
      }
      if (pathname === "/api/auth/organization/get-active-member-role") {
        return Response.json({ role: "owner" });
      }
      if (pathname === "/v1/me/professional-use") {
        if (professionalUseState.status === "required") {
          return Response.json({ status: "required" });
        }
        return Response.json({
          status: "accepted",
          statementVersion: "2026-10",
          termsVersion: "2026-10",
          acceptedAt: "2026-10-01T00:00:00.000Z",
        });
      }
      if (pathname === "/v1/organization-settings") {
        return Response.json(organizationSettings);
      }
      if (pathname === "/v1/organization-settings/ai-availability") {
        return Response.json({
          available: true,
          unavailableReason: null,
          providerConfiguration: "allowed",
          instanceProvisioned: false,
          orgConfigured: true,
          deferredServiceTierAvailable: false,
          mockAnswers: false,
        } satisfies NonNullable<
          Awaited<
            ReturnType<
              (typeof api)["organization-settings"]["ai-availability"]["get"]
            >
          >["data"]
        >);
      }
      if (pathname === "/v1/workspaces/navigation") {
        return Response.json({
          items: [],
          workspaces: [],
          nextCursor: null,
          limit: 25,
          features: { timeBilling: true },
        } satisfies NonNullable<
          Awaited<ReturnType<typeof api.workspaces.navigation.get>>["data"]
        >);
      }
      if (/^\/v1\/chat\/threads\/[0-9a-f-]{36}\/messages$/u.test(pathname)) {
        return Response.json({ message: "Not found" }, { status: 404 });
      }
      if (pathname === "/v1/chat/threads") {
        return Response.json({
          global: [],
          workspaces: [],
          nextCursor: null,
        } satisfies NonNullable<
          Awaited<ReturnType<typeof api.chat.threads.get>>["data"]
        >);
      }
      if (pathname === `/v1/workspaces/${workspace.id}`) {
        return Response.json(workspace);
      }
      if (pathname === `/v1/workspaces/${workspace.id}/overview`) {
        return Response.json({
          entityCount: 0,
          documentCount: 0,
          taskCount: 0,
          recentEntities: [],
          upcomingAgenda: [],
        } satisfies NonNullable<
          Awaited<
            ReturnType<ReturnType<typeof api.workspaces>["overview"]["get"]>
          >["data"]
        >);
      }
      if (pathname === `/v1/workspaces/${workspace.id}/workflow`) {
        return Response.json({
          running: false,
          run: null,
        } satisfies NonNullable<
          Awaited<
            ReturnType<ReturnType<typeof api.workspaces>["workflow"]["get"]>
          >["data"]
        >);
      }
      if (pathname === `/v1/views/${workspace.id}`) {
        return Response.json([
          {
            id: "00000000-0000-4000-8000-000000000002",
            name: "Fixture calendar",
            version: 1,
            position: 0,
            createdAt: "2026-10-01T00:00:00.000Z",
            layout: {
              type: "calendar",
              version: 1,
              filters: [],
              sorts: [],
              hiddenProperties: [],
              calculations: [],
              datePropertyId: "fixture-date",
              mode: "month",
            },
          },
        ] satisfies NonNullable<
          Awaited<ReturnType<ReturnType<typeof api.views>["get"]>>["data"]
        >);
      }
      if (pathname === `/v1/properties/${workspace.id}`) {
        return Response.json(
          [] satisfies NonNullable<
            Awaited<
              ReturnType<ReturnType<typeof api.properties>["get"]>
            >["data"]
          >,
        );
      }
      if (pathname === "/v1/case/decisions/latest") {
        return Response.json({
          country: "CZE",
          courts: [],
        } satisfies NonNullable<
          Awaited<ReturnType<typeof api.case.decisions.latest.get>>["data"]
        >);
      }
      if (pathname === "/v1/case/decisions/status") {
        return Response.json({
          decisions: 0,
          updatedAt: null,
          courts: [],
        } satisfies NonNullable<
          Awaited<ReturnType<typeof api.case.decisions.status.get>>["data"]
        >);
      }
      if (pathname === "/v1/law/statutes/shelf") {
        return Response.json({
          country: "cze",
          recentlyInForce: [],
          enteringIntoForce: [],
        } satisfies NonNullable<
          Awaited<ReturnType<typeof api.law.statutes.shelf.get>>["data"]
        >);
      }
      // Member pages that host the docked chat read the thread's tool grants.
      if (pathname === "/v1/chat/tool-grants") {
        return Response.json({ grants: [] } satisfies NonNullable<
          Awaited<ReturnType<(typeof api.chat)["tool-grants"]["get"]>>["data"]
        >);
      }
      if (pathname === "/v1/search-history") {
        return Response.json({
          items: [],
          nextCursor: null,
          limit: 20,
          scope: {
            userId: toSafeId<"user">(user.id),
            organizationId: session.activeOrganizationId,
          },
        } satisfies NonNullable<
          Awaited<ReturnType<(typeof api)["search-history"]["get"]>>["data"]
        >);
      }
      if (pathname === "/health") {
        return Response.json({ status: "ok", version: "test" });
      }
      const authResponse = authFixtureResponse(pathname);
      if (authResponse !== undefined) {
        return authResponse;
      }
      const knowledgeResponse = knowledgeFixtureResponse(pathname);
      if (knowledgeResponse !== undefined) {
        return knowledgeResponse;
      }
      const publicResponse = publicFixtureResponse(pathname);
      if (publicResponse !== undefined) {
        return publicResponse;
      }
      unexpectedRequests.push(url);
      return panic(`Unrecorded shell fixture request: ${url}`);
    },
    { preconnect: originalFetch.preconnect },
  );

  return {
    state,
    professionalUseState,
    user,
    requests,
    unexpectedRequests,
    originalFetch,
    originalWindowClose,
    originalEventSource,
  };
};
const loadFixtureRuntime = async (
  {
    mode,
    suite = "leaf-shells",
    parseSearch,
  }: RouteShellProviderFixtureOptions,
  network: ReturnType<typeof installFixtureNetwork>,
) => {
  // Isomorphic functions run their browser half here, as the test preload
  // (src/test-setup.ts) arranges for every test.
  const { routeTree } = await import("@/router");
  const { Route: otpRoute } = await import("@/routes/auth/otp");
  const { createAppQueryClient } = await import("@/lib/react-query");
  const { professionalUseOptions } = await import("@/lib/auth-queries");
  const { createMemoryHistory, createRouter, RouterProvider, useMatches } =
    await import("@tanstack/react-router");
  const {
    act,
    cleanup,
    render,
    waitFor: waitForDom,
  } = await import("@testing-library/react");
  const waitFor = async (assertion: () => void) =>
    waitForDom(assertion, { onTimeout: (error) => error });
  const { useI18nStore } = await import("@/i18n/i18n-store");
  const initializeFixtureI18n = async () => {
    const state = useI18nStore.getState();
    await state.loadMessages(state.lang);
  };
  const { useFormatter, useLocale } = await import("@/i18n/formatting-context");
  const { useRouteErrorLifecycle } =
    await import("@/lib/analytics/route-error-lifecycle-context");
  const { ApiVersionMismatchReporter } =
    await import("@/components/api-version-mismatch-refresh");
  const { useAuthenticatedUser, useMaybeAuthenticatedUser } =
    await import("@/lib/authenticated-user-context");
  const { useAIKeyGate } = await import("@/components/require-ai-key");
  const { useChatEditorManager, useChatEditorExtensions } =
    await import("@/components/chat-editor-provider");
  const { matchedAppFrameScope } = await import("@/routes/-app-frame-scope");
  const { noopAnalytics } = await import("@/lib/analytics/noop");
  const { createRouteErrorLifecycleController } =
    await import("@/lib/analytics/route-error-lifecycle");
  const { parseRouteSearch, stringifyRouteSearch } =
    await import("@/route-search-params");

  const createFixtureRouter = (initialEntry: string) => {
    const queryClient = createAppQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false } });
    const routeErrorLifecycle =
      createRouteErrorLifecycleController(noopAnalytics);
    const caughtErrors: Error[] = [];
    const router = createRouter({
      routeTree,
      parseSearch: parseRouteSearch,
      stringifySearch: stringifyRouteSearch,
      defaultOnCatch: (error) => {
        caughtErrors.push(
          error instanceof Error ? error : new Error(String(error)),
        );
      },
      history: createMemoryHistory({ initialEntries: [initialEntry] }),
      context: {
        queryClient,
        analyticsValue: { analytics: noopAnalytics, client: null },
        presentationPrefs: defaultPresentationPrefs,
        routeErrorLifecycle,
      },
    });
    return { router, queryClient, routeErrorLifecycle, caughtErrors };
  };
  const census = createFixtureRouter("/");
  const registeredRoutes = v.parse(
    v.array(fixtureRouteSchema),
    Object.values(census.router.routesById),
  );
  const routesById = new Map(
    registeredRoutes.map((route) => [route.id, route]),
  );
  const ancestors = (route: FixtureRoute) => {
    const matches: FixtureRoute[] = [];
    for (
      let current: FixtureRoute | undefined = route;
      current;
      current = routesById.get(current.parentRoute?.id ?? "")
    ) {
      matches.unshift(current);
    }
    return matches;
  };
  const isLegacyTool = (route: FixtureRoute) =>
    ancestors(route).some(({ id }) => id === "/tools");
  const hasChildren = (route: FixtureRoute) =>
    registeredRoutes.some(({ parentRoute }) => parentRoute?.id === route.id);
  const uiLeaves = registeredRoutes.filter(
    (route) => !hasChildren(route) && route.options.component !== undefined,
  );
  const selectedLeaves =
    suite === "leaf-shells"
      ? uiLeaves.filter(
          (route) => isLegacyTool(route) === (mode === "legacy-tools"),
        )
      : [];
  const exercised = new Set<string>();
  const expectedCases: string[] = [];
  const usedExceptions = new Set<string>();
  const params = {
    workspaceId: "00000000-0000-4000-8000-000000000001",
    viewId: "00000000-0000-4000-8000-000000000002",
    companyId: "27074358",
    contactId: "00000000-0000-4000-8000-000000000003",
    correspondenceId: "00000000-0000-4000-8000-000000000004",
    country: "cze",
    court: "ns",
    language: "cs",
    slug: KNOWLEDGE_FIXTURE_TOOL_SLUG,
    version: "2026-01-01",
    registry: "ares",
    entry: KNOWLEDGE_FIXTURE_TOOL_SLUG,
    exportId: "00000000-0000-4000-8000-000000000005",
    invitationId: "00000000-0000-4000-8000-000000000006",
    invoiceId: "00000000-0000-4000-8000-000000000007",
    tableId: "00000000-0000-4000-8000-000000000008",
    threadId: "00000000-0000-4000-8000-000000000009",
    packId: "general-legal",
    templateId: "nda",
    code: "abcdmnp239",
    year: "2026",
    month: "10",
    bucket: "a",
  };
  const hasUi = (route: FixtureRoute): boolean =>
    route.options.component !== undefined ||
    registeredRoutes.some(
      (candidate) => candidate.parentRoute?.id === route.id && hasUi(candidate),
    );
  return {
    mode,
    suite,
    parseSearch,
    createFixtureRouter,
    professionalUseOptions,
    census,
    registeredRoutes,
    otpRoute,
    ancestors,
    isLegacyTool,
    uiLeaves,
    selectedLeaves,
    exercised,
    expectedCases,
    usedExceptions,
    params,
    hasUi,
    act,
    cleanup,
    render,
    waitFor,
    initializeI18n: initializeFixtureI18n,
    useFormatter,
    useLocale,
    useRouteErrorLifecycle,
    ApiVersionMismatchReporter,
    useAuthenticatedUser,
    useMaybeAuthenticatedUser,
    useAIKeyGate,
    useChatEditorManager,
    useChatEditorExtensions,
    matchedAppFrameScope,
    RouterProvider,
    useMatches,
    ...network,
  };
};
type FixtureRuntime = Awaited<ReturnType<typeof loadFixtureRuntime>>;
const fixtureSearch = (routeId: string, email: string) => {
  switch (routeId) {
    case "/auth/otp":
      return { email };
    case "/mcp/oauth-callback":
      return { status: "error" };
    case "/law/":
    case "/law/cases/":
      return { country: "cze" };
    case "/dev":
      return { visual: "chat-long-paste" };
    default:
      return {};
  }
};
const fixtureLocation = (
  fullPath: string,
  params: Record<string, string>,
  search: Record<string, string>,
) => {
  const pathname = fullPath.replace(
    /\$([A-Za-z][A-Za-z0-9]*)/gu,
    (_, key: string) => {
      const value = params[key];
      return value ?? panic(`Missing route fixture param: ${key}`);
    },
  );
  const query = new URLSearchParams(search).toString();
  return query.length === 0 ? pathname : `${pathname}?${query}`;
};
const compareRouteIds = (left: string, right: string) => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};
const declareCensus = (fixture: FixtureRuntime) => {
  const {
    mode,
    suite,
    parseSearch,
    registeredRoutes,
    isLegacyTool,
    uiLeaves,
    selectedLeaves,
    hasUi,
  } = fixture;
  if (suite === "route-search") {
    const readSearch =
      parseSearch ??
      panic("The route-search suite needs the router's search parser.");
    test("every route opens whatever its URL's search carries", () => {
      expect(
        routeSearchRefusals(
          registeredRoutes,
          (routeId) => fixtureSearch(routeId, "reader@example.com"),
          readSearch,
        ),
      ).toEqual([]);
    });
    test("changing the OTP email reloads its actual loader for that address", async () => {
      const { otpRoute } = fixture;
      const loader = otpRoute.options.loader;
      if (typeof loader !== "function") {
        panic("The actual OTP route must declare its loader");
      }
      const loadedEmails: string[] = [];
      otpRoute.options.loader = (args): unknown => {
        loadedEmails.push(args.context.otpEmail);
        return loader(args);
      };
      fixture.state.audience = "anonymous";
      const { router, queryClient, caughtErrors } = fixture.createFixtureRouter(
        "/auth/otp?email=first%40example.test",
      );
      try {
        await router.load();
        expect(loadedEmails).toEqual(["first@example.test"]);
        await router.navigate({
          to: "/auth/otp",
          search: { email: "second@example.test" },
        });
        expect(loadedEmails).toEqual([
          "first@example.test",
          "second@example.test",
        ]);
        expect(
          router.state.matches.find((match) => match.routeId === "/auth/otp")
            ?.status,
        ).toBe("success");
        expect(caughtErrors).toEqual([]);
      } finally {
        await queryClient.cancelQueries();
        queryClient.clear();
        otpRoute.options.loader = loader;
      }
    });
  }
  if (suite === "leaf-shells") {
    test(`${mode}: every top-level UI section declares its runtime frame scope`, () => {
      expect(
        registeredRoutes
          .filter(
            (route) => route.parentRoute?.id === "__root__" && hasUi(route),
          )
          .filter((route) => route.options.staticData?.appFrame === undefined)
          .map(({ id }) => id),
      ).toEqual([]);
      const publicLeaves = uiLeaves.filter((route) => !isLegacyTool(route));
      const legacyLeaves = uiLeaves.filter(isLegacyTool);
      expect(
        [...publicLeaves, ...legacyLeaves]
          .map(({ id }) => id)
          .toSorted(compareRouteIds),
      ).toEqual(uiLeaves.map(({ id }) => id).toSorted(compareRouteIds));
      expect(selectedLeaves.length).toBeGreaterThan(0);
      expect(
        Object.keys(publicRouteExceptions).filter(
          (id) =>
            !uiLeaves.some(
              (route) =>
                route.id === id ||
                `${route.id}:anonymous` === id ||
                `${route.id}:member` === id,
            ),
        ),
      ).toEqual([]);
    });
  }
};
const declareLeafCases = (fixture: FixtureRuntime) => {
  const {
    mode,
    createFixtureRouter,
    ancestors,
    selectedLeaves,
    exercised,
    expectedCases,
    usedExceptions,
    params,
    act,
    cleanup,
    render,
    waitFor,
    initializeI18n,
    useFormatter,
    useLocale,
    useRouteErrorLifecycle,
    ApiVersionMismatchReporter,
    useAuthenticatedUser,
    useMaybeAuthenticatedUser,
    useAIKeyGate,
    useChatEditorManager,
    useChatEditorExtensions,
    matchedAppFrameScope,
    RouterProvider,
    useMatches,
    state,
    user,
    unexpectedRequests,
  } = fixture;
  for (const route of selectedLeaves) {
    const protectedLeaf = ancestors(route).some(
      ({ id }) => id === "/_protected",
    );
    const exception = publicRouteExceptions[route.id];
    if (exception !== undefined) {
      if (protectedLeaf || exception.trim().length === 0) {
        panic(`Invalid public route exception: ${route.id}`);
      }
      usedExceptions.add(route.id);
      test(`${mode}: ${route.id} original-page exception: ${exception}`, () =>
        expect(exception.length).toBeGreaterThan(0));
      continue;
    }
    for (const caseAudience of protectedLeaf
      ? [FIXTURE_AUDIENCE.member]
      : Object.values(FIXTURE_AUDIENCE)) {
      const caseId = `${route.id}:${caseAudience}`;
      const caseException = publicRouteExceptions[caseId];
      if (caseException !== undefined) {
        if (protectedLeaf || caseException.trim().length === 0) {
          panic(`Invalid public route exception: ${caseId}`);
        }
        usedExceptions.add(caseId);
        test(`${mode}: ${caseId} original-page exception: ${caseException}`, () =>
          expect(caseException.length).toBeGreaterThan(0));
        continue;
      }
      expectedCases.push(caseId);
      test(`${mode}: ${caseId} receives its ${protectedLeaf ? "shell" : "original page and shell"} providers`, async () => {
        const search = fixtureSearch(route.id, user.email);
        const path = fixtureLocation(route.fullPath, params, search);
        const scope = matchedAppFrameScope(
          ancestors(route).map(({ options }) => {
            const appFrame = options.staticData?.appFrame;
            return appFrame === undefined
              ? { staticData: {} }
              : { staticData: { appFrame } };
          }),
        );
        state.audience = caseAudience;
        unexpectedRequests.length = 0;
        const { router, queryClient, routeErrorLifecycle, caughtErrors } =
          createFixtureRouter(path);
        const original = { ...route.options };
        const MemberProbe = () => {
          const member = useAuthenticatedUser();
          const gate = useAIKeyGate();
          const editor = useChatEditorManager();
          useChatEditorExtensions();
          return (
            <output data-testid="member-probe">
              {JSON.stringify({
                user: member.id,
                gate: typeof gate.ensureAIAvailable,
                editor: typeof editor.focusThread,
              })}
            </output>
          );
        };
        const Probe = () => {
          const formatter = useFormatter();
          const locale = useLocale();
          const lifecycle = useRouteErrorLifecycle();
          const maybeUser = useMaybeAuthenticatedUser();
          const routeId = useMatches({
            select: (matches) => matches.at(-1)?.routeId,
          });
          return (
            <>
              {(scope === "member" ||
                (scope === "knowledge" && maybeUser !== null)) && (
                <MemberProbe />
              )}
              <ApiVersionMismatchReporter />
              <output data-testid="shell-probe">
                {JSON.stringify({
                  routeId,
                  locale,
                  number: formatter.number(1234),
                  lifecycle: lifecycle === routeErrorLifecycle,
                })}
              </output>
            </>
          );
        };
        const Original = original.component;
        if (!Original) {
          panic(`Missing registered page component: ${route.id}`);
        }
        const Page = () => (
          <>
            <Original />
            <Probe />
            <output data-testid="original-page-mounted" />
          </>
        );
        const loaderFixture =
          publicFixtureLoaderData(route.id) ??
          authFixtureLoaderData(route.id) ??
          knowledgeFixtureLoaderData(route.id);
        let loader = original.loader;
        if (protectedLeaf) {
          loader = undefined;
        } else if (loaderFixture !== undefined) {
          loader = () => loaderFixture;
        }
        route.update({
          component: protectedLeaf ? Probe : Page,
          beforeLoad: protectedLeaf
            ? undefined
            : () => authFixtureBeforeLoadData(route.id, user.email),
          loader,
        });
        await initializeI18n();
        try {
          await act(async () => {
            await router.load();
            render(<RouterProvider router={router} />, {
              container: document,
              onCaughtError: (error) => {
                caughtErrors.push(
                  error instanceof Error ? error : panic(String(error)),
                );
              },
            });
          });
          await waitFor(() => {
            expect(
              document.querySelector('[data-testid="shell-probe"]')
                ?.textContent,
            ).toContain('"lifecycle":true');
          });
          const result = document.querySelector(
            '[data-testid="shell-probe"]',
          )?.textContent;
          expect(result).toContain(JSON.stringify(route.id));
          expect(result).toContain('"number":"1,234"');
          if (
            (scope === "member" || scope === "knowledge") &&
            caseAudience === "member"
          ) {
            await waitFor(() =>
              expect(
                document.querySelector('[data-testid="member-probe"]')
                  ?.textContent,
              ).toBe(
                JSON.stringify({
                  user: user.id,
                  gate: "function",
                  editor: "function",
                }),
              ),
            );
          }
          await waitFor(() => expect(queryClient.isFetching()).toBe(0));
          const readyText =
            publicFixtureReadyText(route.id) ??
            knowledgeFixtureReadyText(route.id);
          if (!protectedLeaf && readyText !== undefined) {
            await waitFor(() =>
              expect(document.body.textContent).toContain(readyText),
            );
          }
          const readySelector = publicFixtureReadySelector(
            route.id,
            caseAudience,
          );
          if (!protectedLeaf && readySelector !== undefined) {
            await waitFor(() =>
              expect(document.querySelector(readySelector)).not.toBeNull(),
            );
          }
          await waitFor(() => expect(queryClient.isFetching()).toBe(0));
          expect(unexpectedRequests).toEqual([]);
          expect(caughtErrors).toEqual([]);
          if (!protectedLeaf) {
            expect(
              document.querySelector('[data-testid="original-page-mounted"]'),
            ).not.toBeNull();
          }
          exercised.add(caseId);
        } finally {
          route.update(original);
          await act(async () => {
            await queryClient.cancelQueries();
            queryClient.clear();
            cleanup();
          });
        }
      });
    }
  }
};
const declareLawCases = async (fixture: FixtureRuntime) => {
  const {
    suite,
    createFixtureRouter,
    registeredRoutes,
    act,
    cleanup,
    render,
    waitFor,
    initializeI18n,
    useFormatter,
    useRouteErrorLifecycle,
    useAuthenticatedUser,
    useMaybeAuthenticatedUser,
    useAIKeyGate,
    useChatEditorManager,
    useChatEditorExtensions,
    RouterProvider,
    state,
    user,
    requests,
    unexpectedRequests,
  } = fixture;
  if (suite === "law-hosts") {
    const { registerInspectorView } =
      await import("@/components/inspector/view-registry");
    const { useInspectorTabsStore } =
      await import("@/components/inspector/inspector-tabs-store");
    const { INSPECTOR_PANE_INTENT } =
      await import("@/components/inspector/inspector-store-types");
    const viewType = "test-route-shell-provider-probe";
    const InspectorMemberProbe = () => {
      const member = useAuthenticatedUser();
      const gate = useAIKeyGate();
      const editor = useChatEditorManager();
      useChatEditorExtensions();
      return (
        <output data-testid="law-host-probe">
          {JSON.stringify({
            audience: "member",
            user: member.id,
            ai: typeof gate.ensureAIAvailable,
            composer: typeof editor.focusThread,
          })}
        </output>
      );
    };
    const InspectorProbe = () => {
      const member = useMaybeAuthenticatedUser();
      const formatter = useFormatter();
      useRouteErrorLifecycle();
      return member === null ? (
        <output data-testid="law-host-probe">
          {JSON.stringify({
            audience: "anonymous",
            number: formatter.number(1234),
          })}
        </output>
      ) : (
        <InspectorMemberProbe />
      );
    };
    registerInspectorView({
      type: viewType,
      render: InspectorProbe,
      railIcon: () => null,
      validate: (payload: unknown): payload is { type: "provider-probe" } =>
        typeof payload === "object" &&
        payload !== null &&
        "type" in payload &&
        payload.type === "provider-probe",
    });
    const lawLeaf = registeredRoutes.find(({ id }) => id === "/law/");
    const lawLayout = registeredRoutes.find(({ id }) => id === "/law");
    if (!lawLeaf || !lawLayout) {
      panic("The actual law leaf and layout must be registered");
    }
    for (const scenario of Object.values(LAW_SCENARIO)) {
      test(`real law page: ${scenario} inspector host receives its route provider contract`, async () => {
        state.audience = scenario === "anonymous" ? "anonymous" : "member";
        requests.length = 0;
        unexpectedRequests.length = 0;
        const { router, queryClient, caughtErrors } =
          createFixtureRouter("/law?country=cze");
        const originalLeafOptions = { ...lawLeaf.options };
        const originalLayoutOptions = { ...lawLayout.options };
        const originalTabs = useInspectorTabsStore.getState();
        const Original = originalLeafOptions.component;
        if (!Original) {
          panic("The actual law page must declare a component");
        }
        const Page = () => (
          <>
            <Original />
            <output data-testid="law-original-mounted" />
          </>
        );
        lawLeaf.update({ component: Page });
        if (scenario === "undeclared") {
          lawLayout.update({
            staticData: { ...lawLayout.options.staticData, providerScopes: [] },
          });
        }
        useInspectorTabsStore.getState().openView({
          type: viewType,
          id: "test-route-shell-provider-tab",
          label: "Shell provider fixture",
          payload: { type: "provider-probe" },
          pane: INSPECTOR_PANE_INTENT.expand,
        });
        await initializeI18n();
        try {
          await act(async () => {
            await router.load();
            render(<RouterProvider router={router} />, {
              container: document,
              onCaughtError: (error) => {
                caughtErrors.push(
                  error instanceof Error ? error : panic(String(error)),
                );
              },
            });
          });
          if (scenario === "undeclared") {
            await waitFor(() =>
              expect(
                caughtErrors.map(({ message }) => message).join("\n"),
              ).toContain(
                "Route /law/ is missing declared provider scope: auth",
              ),
            );
            expect(document.body.textContent).toContain(
              "This page couldn’t be opened",
            );
          } else {
            await waitFor(() =>
              expect(
                document.querySelector('[data-testid="law-original-mounted"]'),
              ).not.toBeNull(),
            );
            const expected =
              state.audience === "anonymous"
                ? { audience: "anonymous", number: "1,234" }
                : {
                    audience: "member",
                    user: user.id,
                    ai: "function",
                    composer: "function",
                  };
            await waitFor(() =>
              expect(
                document.querySelector('[data-testid="law-host-probe"]')
                  ?.textContent,
              ).toBe(JSON.stringify(expected)),
            );
            await waitFor(() => expect(queryClient.isFetching()).toBe(0));
            expect(caughtErrors).toEqual([]);
            expect(requests).toContain("/v1/case/decisions/latest");
            expect(
              requests.includes("/v1/organization-settings/ai-availability"),
            ).toBe(state.audience === "member");
          }
          expect(unexpectedRequests).toEqual([]);
        } finally {
          lawLeaf.update(originalLeafOptions);
          lawLayout.update(originalLayoutOptions);
          useInspectorTabsStore.setState(originalTabs, true);
          await act(async () => {
            await queryClient.cancelQueries();
            queryClient.clear();
            cleanup();
          });
        }
      });
    }
  }
};
const declareProfessionalUseCases = (fixture: FixtureRuntime) => {
  if (fixture.suite !== "professional-use") {
    return;
  }
  test("the development playground loads without an authentication service", async () => {
    const requestsBeforeLoad = fixture.requests.length;
    const { router, queryClient } = fixture.createFixtureRouter(
      "/dev?visual=control-sizes",
    );
    try {
      await router.load();
      expect(router.state.location.pathname).toBe("/dev");
      expect(
        router.state.matches.find((match) => match.routeId === "/dev")?.status,
      ).toBe("success");
      expect(queryClient.getQueryState(sessionOptions.queryKey)).toBeUndefined();
      expect(
        fixture.requests.slice(requestsBeforeLoad).filter(
          (request) =>
            request.startsWith("/api/auth/") ||
            request === "/v1/me/professional-use",
        ),
      ).toEqual([]);
    } finally {
      await queryClient.cancelQueries();
      queryClient.clear();
    }
  });
  const casePath = "/law/cze/cases/ns/cs/fixture?q=contract";
  const caseRoute = fixture.registeredRoutes.find(
    ({ id }) => id === "/law/$country/cases/$court/$language/$slug",
  );
  if (caseRoute === undefined) {
    panic("Missing public case-law fixture route");
  }
  const original = { ...caseRoute.options };
  const CasePage = () => <output data-testid="professional-use-case-page" />;

  const runCase = async (
    audience: FixtureAudience,
    status: "accepted" | "required",
  ) => {
    fixture.state.audience = audience;
    fixture.professionalUseState.status = status;
    fixture.unexpectedRequests.length = 0;
    caseRoute.update({
      component: CasePage,
      beforeLoad: () => authFixtureBeforeLoadData(caseRoute.id, fixture.user.email),
      loader: () => publicFixtureLoaderData(caseRoute.id),
    });
    await fixture.initializeI18n();
    const runtime = fixture.createFixtureRouter(casePath);
    return { ...runtime, path: casePath };
  };

  test.each([
    ["an accepted account", FIXTURE_AUDIENCE.member, "accepted"],
    ["an anonymous visitor", FIXTURE_AUDIENCE.anonymous, "accepted"],
  ] satisfies readonly (readonly [string, FixtureAudience, "accepted"])[])(
    "%s stays on a public case-law page",
    async (_name, audience, status) => {
      const { router, queryClient, caughtErrors, path } = await runCase(
        audience,
        status,
      );
      try {
        await fixture.act(async () => {
          await router.load();
          fixture.render(<fixture.RouterProvider router={router} />, {
            container: document,
          });
        });
        await fixture.waitFor(() =>
          expect(
            document.querySelector(
              '[data-testid="professional-use-case-page"]',
            ),
          ).not.toBeNull(),
        );
        expect(
          `${router.state.location.pathname}${router.state.location.searchStr}`,
        ).toBe(path);
        expect(caughtErrors).toEqual([]);
        expect(fixture.unexpectedRequests).toEqual([]);
      } finally {
        await fixture.act(async () => {
          await queryClient.cancelQueries();
          queryClient.clear();
          fixture.cleanup();
        });
        caseRoute.update(original);
      }
    },
  );

  test("a required account returns to the public case-law page after acceptance", async () => {
    const { router, queryClient, caughtErrors, path } = await runCase(
      FIXTURE_AUDIENCE.member,
      "required",
    );
    try {
      await router.load();
      expect(router.state.location.pathname).toBe("/auth/professional-use");
      expect(router.state.location.search).toEqual({ redirectTo: path });

      fixture.professionalUseState.status = "accepted";
      queryClient.removeQueries({
        queryKey: fixture.professionalUseOptions(fixture.user.id).queryKey,
      });
      await fixture.act(async () => {
        await router.navigate({ to: path });
        fixture.render(<fixture.RouterProvider router={router} />, {
          container: document,
        });
      });
      await fixture.waitFor(() =>
        expect(
          document.querySelector('[data-testid="professional-use-case-page"]'),
        ).not.toBeNull(),
      );
      expect(
        `${router.state.location.pathname}${router.state.location.searchStr}`,
      ).toBe(path);
      expect(caughtErrors).toEqual([]);
      expect(fixture.unexpectedRequests).toEqual([]);
    } finally {
      await fixture.act(async () => {
        await queryClient.cancelQueries();
        queryClient.clear();
        fixture.cleanup();
      });
      caseRoute.update(original);
    }
  });

  test.each([
    ["accepted member", FIXTURE_AUDIENCE.member, "accepted"],
    ["required member", FIXTURE_AUDIENCE.member, "required"],
    ["anonymous visitor", FIXTURE_AUDIENCE.anonymous, "accepted"],
  ] satisfies readonly (readonly [
    string,
    FixtureAudience,
    "accepted" | "required",
  ])[])(
    "public SSR leaves auth uncached and hydration checks the %s",
    async (_name, audience, status) => {
      const { router, queryClient, caughtErrors, path } = await runCase(
        FIXTURE_AUDIENCE.anonymous,
        status,
      );
      const serverEnvironment = Object.getOwnPropertyDescriptor(import.meta.env, "SSR");
      const requestsBeforeSsr = fixture.requests.length;
      try {
        Object.assign(import.meta.env, { SSR: true });
        await router.load();
        expect(router.state.location.pathname).toBe(
          new URL(path, window.location.origin).pathname,
        );
        expect(
          queryClient.getQueryState(sessionOptions.queryKey),
        ).toBeUndefined();
        expect(
          fixture.requests
            .slice(requestsBeforeSsr)
            .filter(
              (request) =>
                request.startsWith("/api/auth/") ||
                request === "/v1/me/professional-use",
            ),
        ).toEqual([]);

        // Bun aliases import.meta.env to process.env, where false becomes "false".
        expect(Reflect.deleteProperty(import.meta.env, "SSR")).toBe(true);
        fixture.state.audience = audience;
        fixture.act(() => {
          fixture.render(<fixture.RouterProvider router={router} />, {
            container: document,
          });
        });
        await fixture.waitFor(() => {
          expect(
            queryClient.getQueryState(sessionOptions.queryKey)?.status,
          ).toBe("success");
          expect(router.state.isLoading).toBe(false);
          if (status === "required") {
            expect(router.state.location.pathname).toBe(
              "/auth/professional-use",
            );
            expect(router.state.location.search).toEqual({ redirectTo: path });
          } else {
            expect(
              `${router.state.location.pathname}${router.state.location.searchStr}`,
            ).toBe(path);
            expect(
              document.querySelector(
                '[data-testid="professional-use-case-page"]',
              ),
            ).not.toBeNull();
          }
        });
        const session = queryClient.getQueryData(sessionOptions.queryKey);
        if (audience === FIXTURE_AUDIENCE.member) {
          expect(session?.session.userId).toBe(fixture.user.id);
        } else {
          expect(session).toBeNull();
        }
        expect(caughtErrors).toEqual([]);
        expect(fixture.unexpectedRequests).toEqual([]);
      } finally {
        if (serverEnvironment === undefined) {
          Reflect.deleteProperty(import.meta.env, "SSR");
        } else {
          Object.defineProperty(import.meta.env, "SSR", serverEnvironment);
        }
        await fixture.act(async () => {
          await queryClient.cancelQueries();
          queryClient.clear();
          fixture.cleanup();
        });
        caseRoute.update(original);
      }
    },
  );
};
/** Actual ancestors and public initial pages; leaf guards use recorded fixture data. */
export const declareRouteShellProviderFixture = async (
  options: RouteShellProviderFixtureOptions,
) => {
  setupFixtureEnvironment(options.mode);
  const network = installFixtureNetwork();
  const fixture = await loadFixtureRuntime(options, network);
  declareCensus(fixture);
  declareLeafCases(fixture);
  await declareLawCases(fixture);
  declareProfessionalUseCases(fixture);
  const {
    suite,
    selectedLeaves,
    exercised,
    expectedCases,
    usedExceptions,
    unexpectedRequests,
  } = fixture;
  const { originalFetch, originalWindowClose, originalEventSource } = network;
  afterAll(async () => {
    window.close = originalWindowClose;
    globalThis.EventSource = originalEventSource;
    await unregisterDomEnvironment();
    globalThis.fetch = originalFetch;
    expect(unexpectedRequests).toEqual([]);
    expect([...exercised].toSorted()).toEqual(expectedCases.toSorted());
    if (suite === "leaf-shells") {
      expect([...usedExceptions].toSorted()).toEqual(
        Object.keys(publicRouteExceptions)
          .filter((id) =>
            selectedLeaves.some(
              (route) =>
                route.id === id ||
                `${route.id}:anonymous` === id ||
                `${route.id}:member` === id,
            ),
          )
          .toSorted(),
      );
    }
  });
};
