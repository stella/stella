import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { RouteComponent } from "@tanstack/react-router";
import { plugin } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

// A DOM for this file only: the frames and sections mount, fetch and react to
// session changes, which a static render cannot show. Everything that touches
// the DOM is loaded after it exists.
GlobalRegistrator.register({
  url: "http://localhost:3000/knowledge/templates",
});

// Knowledge readable without an account, for this file.
Object.assign(import.meta.env, { VITE_PUBLIC_KNOWLEDGE_ENABLED: "true" });

// The build turns a `?worker&url` import into the emitted worker's URL; the
// member frame only holds on to it.
plugin({
  name: "worker-url",
  setup(build) {
    build.onLoad({ filter: /\?worker&url$/u }, () => ({
      contents: 'export default "/worker.js";',
      loader: "js",
    }));
  },
});

// The member frame holds the signed-in user's event stream open. These pages
// assert on requests and timing, so the stream stays open and silent instead
// of dialing a server that is not there.
class SilentEventSource extends EventTarget {
  static readonly CLOSED = 2;
  readyState = 1;
  readonly url: string;
  constructor(url: string | URL) {
    super();
    this.url = String(url);
  }
  close() {
    this.readyState = SilentEventSource.CLOSED;
  }
}
Object.assign(globalThis, { EventSource: SilentEventSource });

// Build-time constants the member frame shows.
for (const name of ["__APP_VERSION__", "__APP_COMMIT_SHA__"]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: "test",
  });
}

// ── The network ─────────────────────────────────────

type Session = "checking" | "anonymous" | "org-a" | "org-b";

let session: Session = "checking";
const requests: { path: string; session: Session }[] = [];
let holdMemberTemplates = false;
let templateCatalogue: "available" | "empty" | "missing" = "available";
const heldResponses: (() => void)[] = [];

const SESSION_USER = {
  id: "user-1",
  email: "member@example.test",
  image: null,
  name: "Member",
  preferredName: null,
  timezoneId: "Europe/Prague",
  wordEditShortcut: null,
};

const CATALOGUE_PACK = {
  id: "general-legal",
  name: "General legal",
  version: "1.0.0",
  description: "General templates",
  license: "CC0-1.0",
  licenseUrl: null,
  source: null,
  authors: [],
  jurisdictions: [],
  languages: ["en"],
  legalAreas: [],
  lastReviewedAt: null,
  disclaimer: null,
  templateCount: 1,
};

const CATALOGUE_TEMPLATE = {
  id: "nda",
  title: "Catalogue nondisclosure agreement",
  jurisdictions: [],
  languages: ["en"],
  legalArea: null,
  license: "CC0-1.0",
  fields: ["party"],
  sha256: "0".repeat(64),
};

const CATALOGUE_STARTER = {
  id: "nda-review",
  name: "Catalogue NDA review",
  description: "Review a nondisclosure agreement.",
  positionCount: 3,
};

const libraryTemplate = (name: string) => ({
  id: name.toLowerCase().replaceAll(" ", "-"),
  name,
  fileName: "lease.docx",
  fieldCount: 3,
  sizeBytes: 100,
  categoryId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  lastUsedAt: null,
  useCount: 0,
  tags: null,
  languages: ["en"],
  whenToUse: null,
  whenNotToUse: null,
  authorName: "Member",
  authorImage: null,
});

/** A member of organization A. */
const SIGNED_IN_SESSION = "org-a" satisfies Session;

const LIBRARY_NAME: Record<"org-a" | "org-b", string> = {
  "org-a": "Alpha lease",
  "org-b": "Bravo lease",
};

const sessionBody = () => {
  if (session === "org-a" || session === "org-b") {
    return {
      session: { userId: SESSION_USER.id, activeOrganizationId: session },
      user: SESSION_USER,
    };
  }
  return null;
};

/** Why the caller gave up on a request, as the Error fetch rejects with. */
const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");

/** A response that never comes, unless the caller gives up, as a real
 *  request would let it. */
const unanswered = async (signal: AbortSignal | null | undefined) =>
  await new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => {
      reject(abortReason(signal));
    });
  });

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const signal =
      init?.signal ?? (input instanceof Request ? input.signal : null);
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = url.pathname;
    const askedAs = session;
    requests.push({ path, session: askedAs });

    if (path.endsWith("/api/auth/get-session")) {
      if (askedAs === "checking") {
        // The session read never answers while the visitor is unknown.
        return await unanswered(signal);
      }
      return Response.json(sessionBody());
    }
    if (
      path.endsWith("/api/auth/organization/get-active-member-role") &&
      (askedAs === "org-a" || askedAs === "org-b")
    ) {
      return Response.json({ role: "admin" });
    }
    if (
      path === "/v1/me/professional-use" &&
      (askedAs === "org-a" || askedAs === "org-b")
    ) {
      return Response.json({
        status: "accepted",
        statementVersion: "2026-10",
        termsVersion: "2026-10",
        acceptedAt: "2026-10-01T00:00:00.000Z",
      });
    }
    if (path === "/v1/public/knowledge/template-packs") {
      return Response.json({
        items: templateCatalogue === "missing" ? [] : [CATALOGUE_PACK],
      });
    }
    if (path === "/v1/public/knowledge/template-packs/general-legal") {
      return Response.json({
        ...CATALOGUE_PACK,
        templates: templateCatalogue === "empty" ? [] : [CATALOGUE_TEMPLATE],
      });
    }
    if (
      path ===
      "/v1/public/knowledge/template-packs/general-legal/templates/nda/preview"
    ) {
      return Response.json({
        paragraphs: [
          {
            index: 0,
            text: "The parties agree to keep information confidential.",
          },
        ],
        structureErrors: [],
      });
    }
    if (
      path === "/v1/templates" &&
      (askedAs === "org-a" || askedAs === "org-b")
    ) {
      const body = {
        items: [libraryTemplate(LIBRARY_NAME[askedAs])],
        nextCursor: null,
      };
      if (holdMemberTemplates) {
        // A read in flight across the session change: answered later, with
        // the organization it was asked for.
        return await new Promise<Response>((resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(abortReason(signal));
          });
          heldResponses.push(() => resolve(Response.json(body)));
        });
      }
      return Response.json(body);
    }
    if (path === "/v1/public/knowledge/playbook-starters") {
      return Response.json({ items: [CATALOGUE_STARTER] });
    }
    if (path === "/v1/template-categories") {
      return Response.json({ categories: [] });
    }
    return Response.json({ message: "Not found" }, { status: 404 });
  },
  { preconnect: () => undefined },
);

// ── The app, as far as these pages need it ──────────

const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const testing = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { PendingTextIntlScope } = await import("@/components/pending-text");
const { TooltipProvider } = await import("@stll/ui/tooltip");
const { ToastProvider } = await import("@stll/ui/toast");
const { ThemeProvider } = await import("@/components/theme-provider");
const { ApiVersionMismatchProvider } =
  await import("@/components/api-version-mismatch-refresh");
const { RouteErrorLifecycleProvider } =
  await import("@/lib/analytics/route-error-lifecycle-context");
const { createRouteErrorLifecycleController } =
  await import("@/lib/analytics/route-error-lifecycle");
const { HotkeysProvider } = await import("@tanstack/react-hotkeys");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const messages = (await import("@/i18n/langs/en.json")).default;
const { professionalUseOptions, refreshAuthQueries } =
  await import("@/lib/auth-queries");
const { AppFrameHost } = await import("@/routes/-app-frame-host");
const { RouteProviderScopeBoundary } =
  await import("@/components/route-provider-scope/route-provider-scope");
const { Route: KnowledgeLayoutRoute } =
  await import("@/routes/knowledge/route");
const { Route: TemplatesRoute } = await import("@/routes/knowledge/templates");

const { publicKnowledgeKeys } =
  await import("@/features/knowledge/public/public-knowledge-queries");
const { PublicKnowledgeLanding } =
  await import("@/routes/knowledge/-public/public-knowledge-landing");
const { Route: PlaybooksRoute } = await import("@/routes/knowledge/playbooks");
const { Route: PlaybooksCatalogueRoute } =
  await import("@/routes/knowledge/playbooks_.catalogue");
const { Route: ToolsRoute } = await import("@/routes/knowledge/tools");
const { Route: ToolsCatalogueRoute } =
  await import("@/routes/knowledge/tools_.catalogue");
const { Route: ToolEntryRoute } =
  await import("@/routes/knowledge/tools_.$entry");
const { Route: ToolSkillRoute } =
  await import("@/routes/knowledge/tools_.skills.$skillId");
const { Route: CatalogueRoute } =
  await import("@/routes/knowledge/templates_.catalogue");
const { Route: CatalogueIndexRoute } =
  await import("@/routes/knowledge/templates_.catalogue.index");
const { Route: CatalogueDetailRoute } =
  await import("@/routes/knowledge/templates_.catalogue.$packId.$templateId");

/** A page's component, which these routes always declare. */
const componentOf = (component: RouteComponent | undefined) => {
  if (component === undefined) {
    throw new Error("The route declares no component");
  }
  return component;
};

const createApp = (initialEntry = "/knowledge/templates") => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const routeErrorLifecycle = createRouteErrorLifecycleController({
    captureError: () => undefined,
    captureRouteErrorLifecycle: async () => {
      await Promise.resolve();
    },
  });

  const Providers = ({ children }: { children: ReactNode }) => (
    <RouteErrorLifecycleProvider controller={routeErrorLifecycle}>
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <PendingTextIntlScope>
            <FormattingProvider locale="en" timeZone="UTC">
              <HotkeysProvider>
                <ThemeProvider>
                  <TooltipProvider>
                    <ToastProvider>{children}</ToastProvider>
                  </TooltipProvider>
                </ThemeProvider>
              </HotkeysProvider>
            </FormattingProvider>
          </PendingTextIntlScope>
        </IntlProvider>
      </QueryClientProvider>
    </RouteErrorLifecycleProvider>
  );

  const rootRoute = router.createRootRouteWithContext<{
    queryClient: InstanceType<typeof QueryClient>;
  }>()({
    // The root shell bounds every page by its declared provider scopes.
    component: () => (
      <RouteProviderScopeBoundary>
        <ApiVersionMismatchProvider>
          <AppFrameHost>
            <router.Outlet />
          </AppFrameHost>
        </ApiVersionMismatchProvider>
      </RouteProviderScopeBoundary>
    ),
  });
  // The member frame navigates from the signed-in pages' layout, which the
  // real tree always has.
  const protectedRoute = router.createRoute({
    getParentRoute: () => rootRoute,
    id: "_protected",
  });
  const knowledgeRoute = router.createRoute({
    getParentRoute: () => rootRoute,
    path: "/knowledge",
    // The frame and provider scopes the real layout declares pick the frame.
    staticData: { ...KnowledgeLayoutRoute.options.staticData },
    component: componentOf(KnowledgeLayoutRoute.options.component),
  });
  // Attach the real file routes to this test root, as the generated tree does.
  // The id keeps the file route's own (`tools_`), the path the URL's.
  const attach = <TRoute extends { options: object }>(
    route: TRoute,
    id: string,
  ): TRoute => {
    Object.assign(route.options, {
      getParentRoute: () => knowledgeRoute,
      id,
      path: id.replaceAll("_/", "/"),
    });
    return route;
  };
  const templatesRoute = attach(TemplatesRoute, "/templates");
  const playbooksRoute = attach(PlaybooksRoute, "/playbooks");
  const playbooksCatalogueRoute = attach(
    PlaybooksCatalogueRoute,
    "/playbooks_/catalogue",
  );
  const toolsRoute = attach(ToolsRoute, "/tools");
  const toolsCatalogueRoute = attach(ToolsCatalogueRoute, "/tools_/catalogue");
  const toolEntryRoute = attach(ToolEntryRoute, "/tools_/$entry");
  const toolSkillRoute = attach(ToolSkillRoute, "/tools_/skills/$skillId");
  const landingRoute = router.createRoute({
    getParentRoute: () => knowledgeRoute,
    path: "/",
    component: () => <PublicKnowledgeLanding from={undefined} />,
  });
  const catalogueRoute = CatalogueRoute;
  Object.assign(catalogueRoute.options, {
    getParentRoute: () => knowledgeRoute,
    id: "/templates_/catalogue",
    path: "/templates/catalogue",
  });
  const catalogueIndexRoute = CatalogueIndexRoute;
  Object.assign(catalogueIndexRoute.options, {
    getParentRoute: () => catalogueRoute,
    id: "/",
    path: "/",
  });
  const catalogueDetailRoute = CatalogueDetailRoute;
  Object.assign(catalogueDetailRoute.options, {
    getParentRoute: () => catalogueRoute,
    id: "/$packId/$templateId",
    path: "/$packId/$templateId",
  });
  const appRouter = router.createRouter({
    context: { queryClient },
    history: router.createMemoryHistory({
      initialEntries: [initialEntry],
    }),
    isServer: false,
    routeTree: rootRoute.addChildren([
      protectedRoute,
      knowledgeRoute.addChildren([
        templatesRoute,
        playbooksRoute,
        playbooksCatalogueRoute,
        toolsRoute,
        toolsCatalogueRoute,
        toolEntryRoute,
        toolSkillRoute,
        landingRoute,
        catalogueRoute.addChildren([catalogueIndexRoute, catalogueDetailRoute]),
      ]),
    ]),
  });

  const view = testing.render(
    <Providers>
      <router.RouterProvider router={appRouter} />
    </Providers>,
  );
  return { queryClient, appRouter, view };
};

/** Every cached query key, as text. */
const cachedKeys = (queryClient: InstanceType<typeof QueryClient>) =>
  queryClient
    .getQueryCache()
    .getAll()
    .map((query) => JSON.stringify(query.queryKey));

/** An organization's own Knowledge reads. */
const MEMBER_KNOWLEDGE_PATHS = [
  "/v1/templates",
  "/v1/template-categories",
  "/v1/playbooks",
  "/v1/catalogue",
  "/v1/skills",
];

const isPublicRequest = (path: string) =>
  path.endsWith("/api/auth/get-session") ||
  path.startsWith("/v1/public/knowledge/");

// The member frame and page load as separate chunks on first use.
const MEMBER_WAIT = { timeout: 10_000 };

const settle = async () => {
  await testing.act(async () => {
    await sleep(50);
  });
};

beforeAll(() => {
  requests.length = 0;
});

afterAll(async () => {
  // Let React's scheduled work drain before the DOM goes away.
  await settle();
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

describe("Knowledge for every visitor, on one live client", () => {
  test("the catalogue index still shows the public template list", async () => {
    session = "anonymous";
    templateCatalogue = "available";
    requests.length = 0;
    const { view } = createApp("/knowledge/templates/catalogue");
    try {
      await testing.waitFor(() =>
        view.getByRole("button", { name: CATALOGUE_TEMPLATE.title }),
      );
      expect(
        view.getByRole("heading", { level: 2, name: "Templates" }),
      ).toBeDefined();
      expect(requests.filter(({ path }) => !isPublicRequest(path))).toEqual([]);
    } finally {
      view.unmount();
    }
  });

  test("an anonymous detail URL mounts the catalogue detail and preview", async () => {
    session = "anonymous";
    templateCatalogue = "available";
    requests.length = 0;
    const { view } = createApp(
      "/knowledge/templates/catalogue/general-legal/nda",
    );
    try {
      await testing.waitFor(() =>
        view.getByRole("heading", {
          level: 1,
          name: CATALOGUE_TEMPLATE.title,
        }),
      );
      await testing.waitFor(() =>
        view.getByText("The parties agree to keep information confidential."),
      );
      expect(
        view.queryByRole("heading", { level: 2, name: "Templates" }),
      ).toBeNull();
      expect(requests.filter(({ path }) => !isPublicRequest(path))).toEqual([]);
    } finally {
      view.unmount();
    }
  });

  test("while the session is unknown nothing but the session is asked for", async () => {
    session = "checking";
    requests.length = 0;
    const { queryClient, view } = createApp();
    await settle();

    expect(requests.map(({ path }) => path)).toEqual(
      requests.map(() => "/api/auth/get-session"),
    );
    expect(cachedKeys(queryClient)).toEqual([JSON.stringify(["session"])]);
    expect(
      queryClient
        .getQueryCache()
        .find({ queryKey: professionalUseOptions(undefined).queryKey }),
    ).toBeUndefined();
    view.unmount();
  });

  test("a visitor without an account reads only the catalogue, frame included", async () => {
    session = "anonymous";
    requests.length = 0;
    const { queryClient, view } = createApp();
    await testing.waitFor(() =>
      view.getByText("Catalogue nondisclosure agreement"),
    );

    expect(requests.filter(({ path }) => !isPublicRequest(path))).toEqual([]);
    expect(
      queryClient
        .getQueryCache()
        .find({ queryKey: professionalUseOptions(undefined).queryKey }),
    ).toBeUndefined();
    for (const key of cachedKeys(queryClient)) {
      expect(
        key === JSON.stringify(["session"]) ||
          key.startsWith(JSON.stringify(["knowledge", "public"]).slice(0, -1)),
      ).toBe(true);
    }
    view.unmount();
  });

  test.each(["empty", "missing"] as const)(
    "public template surfaces hide an %s catalogue",
    async (state) => {
      session = "anonymous";
      templateCatalogue = state;
      requests.length = 0;
      const { queryClient, appRouter, view } = createApp("/knowledge");
      try {
        await testing.waitFor(() => view.getByText("Tools"));
        await testing.waitFor(() => {
          const catalogue = queryClient
            .getQueryCache()
            .find({ queryKey: publicKnowledgeKeys.templates.catalogue() });
          expect(catalogue?.state.status).toBe("success");
        });
        expect(view.queryByText("Templates")).toBeNull();
        for (const href of [
          "/knowledge/templates",
          "/knowledge/templates/catalogue/general-legal/nda",
        ]) {
          await testing.act(async () => {
            await appRouter.navigate({ href });
          });
          expect(view.queryByText("Templates")).toBeNull();
          expect(
            view.queryByText("Catalogue nondisclosure agreement"),
          ).toBeNull();
          expect(view.queryByText("Catalogue unavailable")).toBeNull();
        }
        expect(
          requests.filter(
            ({ path }) =>
              path === "/v1/public/knowledge/template-packs/general-legal",
          ),
        ).toHaveLength(state === "missing" ? 0 : 1);
      } finally {
        view.unmount();
        templateCatalogue = "available";
      }
    },
  );

  test("organization A, a read in flight, sign-out, then organization B: nothing of A survives", async () => {
    session = "org-a";
    requests.length = 0;
    const { queryClient, appRouter, view } = createApp();
    await testing.waitFor(() => view.getByText("Alpha lease"), MEMBER_WAIT);

    // A read for A is still on its way when the session ends.
    holdMemberTemplates = true;
    const refetchForA = queryClient.invalidateQueries({
      queryKey: ["knowledge", "member", "org-a"],
    });
    await testing.waitFor(() => {
      expect(heldResponses.length).toBeGreaterThan(0);
    });

    session = "anonymous";
    await testing.act(async () => {
      await refreshAuthQueries(queryClient);
    });
    await testing.waitFor(() =>
      view.getByText("Catalogue nondisclosure agreement"),
    );
    expect(view.queryByText("Alpha lease")).toBeNull();

    // The late answer for A lands after the session changed.
    holdMemberTemplates = false;
    await testing.act(async () => {
      for (const respond of heldResponses.splice(0)) {
        respond();
      }
      await refetchForA;
      await sleep(20);
    });
    expect(
      cachedKeys(queryClient).filter((key) => key.includes("org-a")),
    ).toEqual([]);
    expect(view.queryByText("Alpha lease")).toBeNull();

    // Back to the page A was on, and a preload of it: still no member read.
    const beforeRevisit = requests.length;
    await testing.act(async () => {
      await appRouter.navigate({ to: "/knowledge/templates" });
      await appRouter.preloadRoute({ to: "/knowledge/templates" });
      appRouter.history.back();
    });
    await settle();
    expect(
      requests
        .slice(beforeRevisit)
        .filter(({ path }) => !isPublicRequest(path)),
    ).toEqual([]);
    expect(view.queryByText("Alpha lease")).toBeNull();

    // Organization B signs in on the same client, on the catalogue the
    // sign-out left it on; the library is its own page.
    session = "org-b";
    await testing.act(async () => {
      await refreshAuthQueries(queryClient);
    });
    expect(appRouter.state.location.pathname).toBe(
      "/knowledge/templates/catalogue",
    );
    await testing.act(async () => {
      await appRouter.navigate({ to: "/knowledge/templates" });
    });
    await testing.waitFor(() => view.getByText("Bravo lease"), MEMBER_WAIT);
    expect(view.queryByText("Alpha lease")).toBeNull();
    expect(
      cachedKeys(queryClient).filter((key) => key.includes("org-a")),
    ).toEqual([]);
    view.unmount();
  });

  test("switching from organization A to B keeps nothing of A, frame included", async () => {
    session = "org-a";
    requests.length = 0;
    const { queryClient, view } = createApp();
    await testing.waitFor(() => view.getByText("Alpha lease"), MEMBER_WAIT);
    expect(cachedKeys(queryClient).some((key) => key.includes("org-a"))).toBe(
      true,
    );

    session = "org-b";
    await testing.act(async () => {
      await refreshAuthQueries(queryClient);
    });
    await testing.waitFor(() => view.getByText("Bravo lease"), MEMBER_WAIT);

    expect(view.queryByText("Alpha lease")).toBeNull();
    expect(
      cachedKeys(queryClient).filter((key) => key.includes("org-a")),
    ).toEqual([]);
    view.unmount();
  });

  test.each([
    [
      "/knowledge/templates",
      "/knowledge/templates/catalogue",
      "/knowledge/templates_/catalogue/",
    ],
    [
      "/knowledge/playbooks",
      "/knowledge/playbooks/catalogue",
      "/knowledge/playbooks_/catalogue",
    ],
    [
      "/knowledge/tools",
      "/knowledge/tools/catalogue",
      "/knowledge/tools_/catalogue",
    ],
  ] as const)(
    "a visitor without an account on %s reads %s, before and after the session is known",
    async (memberPath, cataloguePath, catalogueRouteId) => {
      session = "anonymous";
      requests.length = 0;
      // Entered cold: the session is read on the page, which turns away.
      const { appRouter, view } = createApp(memberPath);
      try {
        await testing.waitFor(() => {
          expect(appRouter.state.location.pathname).toBe(cataloguePath);
        });
        // With the session known, the route turns away before its page
        // loads: a preload (a hover over a link) follows the redirect and
        // never matches the organization's page, so its code is not fetched.
        let preloaded: { routeId: string }[] | undefined;
        await testing.act(async () => {
          preloaded = await appRouter.preloadRoute({ to: memberPath });
        });
        expect(preloaded?.map(({ routeId }) => routeId)).not.toContain(
          memberPath,
        );
        expect(preloaded?.map(({ routeId }) => routeId)).toContain(
          catalogueRouteId,
        );
        await testing.act(async () => {
          await appRouter.navigate({ to: memberPath });
        });
        await testing.waitFor(() => {
          expect(appRouter.state.location.pathname).toBe(cataloguePath);
        });
        expect(requests.filter(({ path }) => !isPublicRequest(path))).toEqual(
          [],
        );
      } finally {
        view.unmount();
      }
    },
  );

  test("the route turns a known visitor away with a permanent redirect, and only a visitor", async () => {
    const { turnAwaySignedOutVisitor } =
      await import("@/routes/knowledge/-knowledge-member-route");
    const { sessionOptions } = await import("@/lib/auth-query-options");
    const queryClient = new QueryClient();
    const visitor = {
      kind: "catalogue",
      to: "/knowledge/tools/catalogue",
    } as const;

    /** What the route throws, or `"passed"` when it lets the visitor in. */
    const outcome = async (
      target: Parameters<typeof turnAwaySignedOutVisitor>[0]["visitor"],
    ): Promise<unknown> => {
      try {
        await turnAwaySignedOutVisitor({ queryClient, visitor: target });
        return "passed";
      } catch (error: unknown) {
        return error;
      }
    };

    // Unknown: the page decides.
    expect(await outcome(visitor)).toBe("passed");
    // A member, as the session read answers: nothing to turn away.
    session = SIGNED_IN_SESSION;
    await queryClient.query(sessionOptions);
    expect(queryClient.getQueryData(sessionOptions.queryKey)).not.toBeNull();
    expect(await outcome(visitor)).toBe("passed");
    // Known to have no session: a 301 to the catalogue, or not found.
    session = "anonymous";
    await queryClient.query({ ...sessionOptions, staleTime: 0 });
    expect(queryClient.getQueryData(sessionOptions.queryKey)).toBeNull();
    const redirected = await outcome(visitor);
    expect(router.isRedirect(redirected)).toBe(true);
    if (router.isRedirect(redirected)) {
      expect(redirected.status).toBe(301);
      expect(redirected.options.to).toBe("/knowledge/tools/catalogue");
    }
    const missing = await outcome({ kind: "not-found" });
    expect(router.isNotFound(missing)).toBe(true);
  });

  test.each([SIGNED_IN_SESSION, "anonymous"] as const)(
    "the published catalogues read the same for %s, on their own address",
    async (asked) => {
      session = asked;
      requests.length = 0;
      const { appRouter, view } = createApp("/knowledge/playbooks/catalogue");
      try {
        await testing.waitFor(
          () => view.getByText(CATALOGUE_STARTER.name),
          MEMBER_WAIT,
        );
        await testing.act(async () => {
          await appRouter.navigate({ to: "/knowledge/tools/catalogue" });
        });
        await testing.waitFor(() =>
          view.getByRole("heading", { level: 1, name: "Tools" }),
        );
        expect(appRouter.state.location.pathname).toBe(
          "/knowledge/tools/catalogue",
        );
        // The catalogues read only the catalogue, whoever is visiting: no
        // organization's Knowledge is asked for.
        expect(
          requests.filter(({ path }) =>
            MEMBER_KNOWLEDGE_PATHS.some((prefix) => path.startsWith(prefix)),
          ),
        ).toEqual([]);
      } finally {
        view.unmount();
      }
    },
  );

  test("a skill id at a published tool's address moves to the skill's own", async () => {
    session = "anonymous";
    requests.length = 0;
    const skillId = "11111111-1111-4111-8111-111111111111";
    const { appRouter, view } = createApp(`/knowledge/tools/${skillId}`);
    try {
      await testing.waitFor(() => {
        expect(appRouter.state.location.pathname).toBe(
          `/knowledge/tools/skills/${skillId}`,
        );
      });
      // A skill belongs to an organization: a visitor finds nothing there.
      await testing.waitFor(() =>
        view.getByText(messages.publicTools.notFound),
      );
      expect(requests.filter(({ path }) => !isPublicRequest(path))).toEqual([]);
    } finally {
      view.unmount();
    }
  });
});
