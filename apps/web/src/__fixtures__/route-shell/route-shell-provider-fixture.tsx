import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { AnyRoute } from "@tanstack/react-router";
import { panic } from "better-result";
import { plugin } from "bun";
import { afterAll, expect, mock, test } from "bun:test";

import { parseTimeZoneId } from "@stll/time";

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
import { toSafeId } from "@/lib/safe-id";
import { unregisterDomEnvironment } from "@/test-dom-environment";

type RouteShellProviderFixtureOptions = {
  mode: "public-knowledge" | "legacy-tools";
  suite?: "leaf-shells" | "law-hosts";
};

const FIXTURE_AUDIENCE = { anonymous: "anonymous", member: "member" } as const;
type FixtureAudience = (typeof FIXTURE_AUDIENCE)[keyof typeof FIXTURE_AUDIENCE];
const LAW_SCENARIO = { ...FIXTURE_AUDIENCE, undeclared: "undeclared" } as const;
const setupFixtureEnvironment = (
  mode: RouteShellProviderFixtureOptions["mode"],
) => {
  GlobalRegistrator.register({ url: "http://localhost:3000/law" });
  Object.assign(import.meta.env, {
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
    (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      const pathname = new URL(url, window.location.origin).pathname;
      requests.push(pathname);
      if (pathname === "/api/auth/get-session") {
        return Promise.resolve(
          Response.json(state.audience === "member" ? { session, user } : null),
        );
      }
      if (pathname === "/api/auth/organization/get-active-member-role") {
        return Promise.resolve(Response.json({ role: "owner" }));
      }
      if (pathname === "/v1/me/professional-use") {
        return Promise.resolve(
          Response.json({
            status: "accepted",
            statementVersion: "2026-10",
            termsVersion: "2026-10",
            acceptedAt: "2026-10-01T00:00:00.000Z",
          }),
        );
      }
      if (pathname === "/v1/organization-settings") {
        return Promise.resolve(Response.json(organizationSettings));
      }
      if (pathname === "/v1/organization-settings/ai-availability") {
        return Promise.resolve(
          Response.json({
            available: true,
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
          >),
        );
      }
      if (pathname === "/v1/workspaces/navigation") {
        return Promise.resolve(
          Response.json({
            items: [],
            workspaces: [],
            nextCursor: null,
            limit: 25,
            features: { timeBilling: true },
          } satisfies NonNullable<
            Awaited<ReturnType<typeof api.workspaces.navigation.get>>["data"]
          >),
        );
      }
      if (/^\/v1\/chat\/threads\/[0-9a-f-]{36}\/messages$/u.test(pathname)) {
        return Promise.resolve(
          Response.json({ message: "Not found" }, { status: 404 }),
        );
      }
      if (pathname === "/v1/chat/threads") {
        return Promise.resolve(
          Response.json({
            global: [],
            workspaces: [],
            nextCursor: null,
          } satisfies NonNullable<
            Awaited<ReturnType<typeof api.chat.threads.get>>["data"]
          >),
        );
      }
      if (pathname === `/v1/workspaces/${workspace.id}`) {
        return Promise.resolve(Response.json(workspace));
      }
      if (pathname === `/v1/workspaces/${workspace.id}/overview`) {
        return Promise.resolve(
          Response.json({
            entityCount: 0,
            documentCount: 0,
            taskCount: 0,
            recentEntities: [],
            upcomingAgenda: [],
          } satisfies NonNullable<
            Awaited<
              ReturnType<ReturnType<typeof api.workspaces>["overview"]["get"]>
            >["data"]
          >),
        );
      }
      if (pathname === `/v1/workspaces/${workspace.id}/workflow`) {
        return Promise.resolve(
          Response.json({ running: false, run: null } satisfies NonNullable<
            Awaited<
              ReturnType<ReturnType<typeof api.workspaces>["workflow"]["get"]>
            >["data"]
          >),
        );
      }
      if (pathname === `/v1/views/${workspace.id}`) {
        return Promise.resolve(
          Response.json([
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
          >),
        );
      }
      if (pathname === `/v1/properties/${workspace.id}`) {
        return Promise.resolve(
          Response.json(
            [] satisfies NonNullable<
              Awaited<
                ReturnType<ReturnType<typeof api.properties>["get"]>
              >["data"]
            >,
          ),
        );
      }
      if (pathname === "/v1/case/decisions/latest") {
        return Promise.resolve(
          Response.json({ country: "CZE", courts: [] } satisfies NonNullable<
            Awaited<ReturnType<typeof api.case.decisions.latest.get>>["data"]
          >),
        );
      }
      if (pathname === "/v1/case/decisions/status") {
        return Promise.resolve(
          Response.json({
            decisions: 0,
            updatedAt: null,
            courts: [],
          } satisfies NonNullable<
            Awaited<ReturnType<typeof api.case.decisions.status.get>>["data"]
          >),
        );
      }
      if (pathname === "/v1/law/statutes/shelf") {
        return Promise.resolve(
          Response.json({
            country: "cze",
            recentlyInForce: [],
            enteringIntoForce: [],
          } satisfies NonNullable<
            Awaited<ReturnType<typeof api.law.statutes.shelf.get>>["data"]
          >),
        );
      }
      if (pathname === "/v1/search-history") {
        return Promise.resolve(
          Response.json({
            items: [],
            nextCursor: null,
            limit: 20,
            scope: {
              userId: toSafeId<"user">(user.id),
              organizationId: session.activeOrganizationId,
            },
          } satisfies NonNullable<
            Awaited<ReturnType<(typeof api)["search-history"]["get"]>>["data"]
          >),
        );
      }
      if (pathname === "/health") {
        return Promise.resolve(
          Response.json({ status: "ok", version: "test" }),
        );
      }
      const authResponse = authFixtureResponse(pathname);
      if (authResponse !== undefined) {
        return Promise.resolve(authResponse);
      }
      const knowledgeResponse = knowledgeFixtureResponse(pathname);
      if (knowledgeResponse !== undefined) {
        return Promise.resolve(knowledgeResponse);
      }
      const publicResponse = publicFixtureResponse(pathname);
      if (publicResponse !== undefined) {
        return Promise.resolve(publicResponse);
      }
      unexpectedRequests.push(url);
      return panic(`Unrecorded shell fixture request: ${url}`);
    },
    { preconnect: originalFetch.preconnect },
  );

  return {
    state,
    user,
    requests,
    unexpectedRequests,
    originalFetch,
    originalWindowClose,
    originalEventSource,
  };
};
const loadFixtureRuntime = async (
  { mode, suite = "leaf-shells" }: RouteShellProviderFixtureOptions,
  network: ReturnType<typeof installFixtureNetwork>,
) => {
  // Bun does not run Start's client/server build transform. Keep its client
  // implementation, as the browser bundle does, while retaining the real router.
  const start = await import("@tanstack/react-start");
  type ClientHalf = (...args: never[]) => unknown;
  await mock.module("@tanstack/react-start", () => ({
    ...start,
    createIsomorphicFn: () => {
      let clientHalf: ClientHalf = () => undefined;
      const isomorphic = Object.assign(
        (...args: never[]) => clientHalf(...args),
        {
          server: () => isomorphic,
          client: (half: ClientHalf) => {
            clientHalf = half;
            return isomorphic;
          },
        },
      );
      return isomorphic;
    },
  }));

  const { routeTree } = await import("@/routeTree.gen");
  const { createAppQueryClient } = await import("@/lib/react-query");
  const { createMemoryHistory, createRouter, RouterProvider, useMatches } =
    await import("@tanstack/react-router");
  const {
    act,
    cleanup,
    render,
    waitFor: waitForDom,
  } = await import("@testing-library/react");
  const waitFor = (assertion: () => void) =>
    waitForDom(assertion, { onTimeout: (error) => error });
  const { initializeI18n } = await import("@/i18n/i18n-store");
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

  const createFixtureRouter = (initialEntry: string) => {
    const queryClient = createAppQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false } });
    const routeErrorLifecycle =
      createRouteErrorLifecycleController(noopAnalytics);
    const caughtErrors: Error[] = [];
    const router = createRouter({
      routeTree,
      defaultOnCatch: (error) => {
        caughtErrors.push(
          error instanceof Error ? error : new Error(String(error)),
        );
      },
      history: createMemoryHistory({ initialEntries: [initialEntry] }),
      context: {
        queryClient,
        analyticsValue: { analytics: noopAnalytics, client: null },
        routeErrorLifecycle,
      },
    });
    return { router, queryClient, routeErrorLifecycle, caughtErrors };
  };
  const census = createFixtureRouter("/");
  const registeredRoutes = Object.values(census.router.routesById);
  const ancestors = (route: AnyRoute): AnyRoute[] => {
    const matches: AnyRoute[] = [];
    for (
      let current: AnyRoute | undefined = route;
      current;
      current = current.parentRoute
    ) {
      matches.unshift(current);
    }
    return matches;
  };
  const isLegacyTool = (route: AnyRoute) =>
    ancestors(route).some(({ id }) => id === "/tools");
  const uiLeaves = registeredRoutes.filter(
    (route) => !route.children?.length && route.options.component !== undefined,
  );
  const selectedLeaves =
    suite === "law-hosts"
      ? []
      : uiLeaves.filter(
          (route) => isLegacyTool(route) === (mode === "legacy-tools"),
        );
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
  const hasUi = (route: AnyRoute): boolean =>
    route.options.component !== undefined ||
    (route.children?.some(hasUi) ?? false);
  return {
    mode,
    suite,
    createFixtureRouter,
    census,
    registeredRoutes,
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
      return { visual: "shell-pending" };
    default:
      return {};
  }
};
const fixtureLocation = (
  fullPath: string,
  params: Record<string, string>,
  search: Record<string, string>,
) => {
  const pathname = fullPath.replace(/\$([A-Za-z][A-Za-z0-9]*)/gu, (_, key) => {
    const value = params[key];
    return value === undefined
      ? panic(`Missing route fixture param: ${key}`)
      : value;
  });
  const query = new URLSearchParams(search).toString();
  return query.length === 0 ? pathname : `${pathname}?${query}`;
};
const declareCensus = (fixture: FixtureRuntime) => {
  const {
    mode,
    suite,
    registeredRoutes,
    isLegacyTool,
    uiLeaves,
    selectedLeaves,
    hasUi,
  } = fixture;
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
        [...publicLeaves, ...legacyLeaves].map(({ id }) => id).toSorted(),
      ).toEqual(uiLeaves.map(({ id }) => id).toSorted());
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
          ancestors(route).map(({ options }) => ({
            staticData: options.staticData ?? {},
          })),
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
            : () => authFixtureBeforeLoadData(route.id),
          loader,
        });
        await initializeI18n();
        try {
          await act(async () => {
            await router.load();
            render(<RouterProvider router={router} />, {
              container: document,
              onCaughtError: (error) =>
                caughtErrors.push(
                  error instanceof Error ? error : panic(String(error)),
                ),
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
          if (scope !== "none" && caseAudience === "member") {
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
              onCaughtError: (error) =>
                caughtErrors.push(
                  error instanceof Error ? error : panic(String(error)),
                ),
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
