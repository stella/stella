import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { RouteComponent } from "@tanstack/react-router";
import { plugin } from "bun";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

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

// Build-time constants the member frame shows.
for (const name of ["__APP_VERSION__", "__APP_COMMIT_SHA__"]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: "test",
  });
}

// The browser build keeps only the client half of an isomorphic function;
// without the build step both halves exist and the server one would run.
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

// ── The network ─────────────────────────────────────

type Session = "checking" | "anonymous" | "org-a" | "org-b";

let session: Session = "checking";
const requests: { path: string; session: Session }[] = [];
let holdMemberTemplates = false;
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

const libraryTemplate = (name: string) => ({
  id: `${name.toLowerCase().replaceAll(" ", "-")}`,
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

/** A response that never comes, unless the caller gives up, as a real
 *  request would let it. */
const unanswered = async (signal: AbortSignal | null | undefined) =>
  await new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => {
      reject(signal.reason);
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
    if (path === "/v1/public/knowledge/template-packs") {
      return Response.json({ items: [CATALOGUE_PACK] });
    }
    if (path === "/v1/public/knowledge/template-packs/general-legal") {
      return Response.json({
        ...CATALOGUE_PACK,
        templates: [CATALOGUE_TEMPLATE],
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
            reject(signal.reason);
          });
          heldResponses.push(() => resolve(Response.json(body)));
        });
      }
      return Response.json(body);
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
const { refreshAuthQueries } = await import("@/lib/auth-queries");
const { discardBootPrefetch } = await import("@/boot-prefetch");
const { AppFrameHost } = await import("@/routes/-app-frame-host");
const { Route: KnowledgeLayoutRoute } =
  await import("@/routes/knowledge/route");
const { Route: TemplatesRoute } = await import("@/routes/knowledge/templates");

/** A page's component, which these routes always declare. */
const componentOf = (component: RouteComponent | undefined) => {
  if (component === undefined) {
    throw new Error("The route declares no component");
  }
  return component;
};

const createApp = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const routeErrorLifecycle = createRouteErrorLifecycleController({
    captureError: () => undefined,
    captureRouteErrorLifecycle: () => undefined,
  });

  const Providers = ({ children }: { children: ReactNode }) => (
    <RouteErrorLifecycleProvider controller={routeErrorLifecycle}>
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <FormattingProvider locale="en" timeZone="UTC">
            <HotkeysProvider>
              <ThemeProvider>
                <TooltipProvider>
                  <ToastProvider>{children}</ToastProvider>
                </TooltipProvider>
              </ThemeProvider>
            </HotkeysProvider>
          </FormattingProvider>
        </IntlProvider>
      </QueryClientProvider>
    </RouteErrorLifecycleProvider>
  );

  const rootRoute = router.createRootRoute({
    component: () => (
      <ApiVersionMismatchProvider>
        <AppFrameHost>
          <router.Outlet />
        </AppFrameHost>
      </ApiVersionMismatchProvider>
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
    component: componentOf(KnowledgeLayoutRoute.options.component),
  });
  const templatesRoute = router.createRoute({
    getParentRoute: () => knowledgeRoute,
    path: "templates",
    validateSearch: TemplatesRoute.options.validateSearch,
    component: componentOf(TemplatesRoute.options.component),
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({
      initialEntries: ["/knowledge/templates"],
    }),
    isServer: false,
    routeTree: rootRoute.addChildren([
      protectedRoute,
      knowledgeRoute.addChildren([templatesRoute]),
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

const isPublicRequest = (path: string) =>
  path.endsWith("/api/auth/get-session") ||
  path.startsWith("/v1/public/knowledge/");

// The member frame and page load as separate chunks on first use.
const MEMBER_WAIT = { timeout: 10_000 };

const settle = async () => {
  await testing.act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  });
};

beforeAll(() => {
  // The page did not boot here, so there is no early session read to reuse.
  discardBootPrefetch();
  requests.length = 0;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await GlobalRegistrator.unregister();
});

describe("Knowledge for every visitor, on one live client", () => {
  test("while the session is unknown nothing but the session is asked for", async () => {
    session = "checking";
    requests.length = 0;
    const { queryClient, view } = createApp();
    await settle();

    expect(requests.map(({ path }) => path)).toEqual(
      requests.map(() => "/api/auth/get-session"),
    );
    expect(cachedKeys(queryClient)).toEqual([JSON.stringify(["session"])]);
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
    for (const key of cachedKeys(queryClient)) {
      expect(
        key === JSON.stringify(["session"]) ||
          key.startsWith(JSON.stringify(["knowledge", "public"]).slice(0, -1)),
      ).toBe(true);
    }
    view.unmount();
  });

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
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
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

    // Organization B signs in on the same client.
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
  }, 30_000);

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
  }, 30_000);
});
