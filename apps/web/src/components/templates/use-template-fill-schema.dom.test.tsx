import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost:3000/template-fill" });

const TEMPLATE_ID = "00000000-0000-4000-8000-000000000001";
const originalFetch = globalThis.fetch;
const discoveredTemplateIds: unknown[] = [];
let version = 1;
const sync = Promise.withResolvers<undefined>();
const syncStarted = Promise.withResolvers<undefined>();
const linkedClause = () => ({
  id: "link_1",
  clauseId: "clause_1",
  clauseVariantId: null,
  clauseVariantLabel: null,
  clauseVersionId: `version_${version}`,
  slotName: "terms",
  sortOrder: 0,
  insertedAt: "2026-01-01",
  clause: { id: "clause_1", title: "Terms", currentVersion: 2 },
  clauseVersion: { id: `version_${version}`, version },
  clauseVariant: null,
  isOutdated: version === 1,
  variantDeleted: false,
});
const requests: string[] = [];
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url.pathname);
    if (url.pathname.startsWith("/api/auth/")) {
      return Response.json(null);
    }
    if (url.pathname === `/v1/templates/${TEMPLATE_ID}/clauses`) {
      return Response.json({ links: [linkedClause()] });
    }
    if (url.pathname === `/v1/templates/${TEMPLATE_ID}/clause-slots`) {
      return Response.json({ slots: [] });
    }
    if (url.pathname === `/v1/templates/${TEMPLATE_ID}/clauses/sync`) {
      syncStarted.resolve(undefined);
      await sync.promise;
      version = 2;
      return Response.json({ syncedCount: 1 });
    }
    if (url.pathname === `/v1/templates/${TEMPLATE_ID}`) {
      return Response.json({
        fileName: "terms.docx",
        presignedUrl: "http://localhost:3001/source.docx",
        manifest: { version: 1, fields: [] },
      });
    }
    if (url.pathname === "/source.docx") {
      return new Response(new Uint8Array([1, 2, 3]));
    }
    if (url.pathname === "/v1/templates/discover") {
      const body = init?.body;
      if (!(body instanceof FormData) && typeof body !== "string") {
        throw new TypeError("expected a FormData or JSON request body");
      }
      const payload =
        body instanceof FormData
          ? { templateId: body.get("templateId"), file: body.get("file") }
          : JSON.parse(body);
      expect(payload.file).toBeUndefined();
      const templateId = payload.templateId;
      discoveredTemplateIds.push(templateId);
      // The template body has no variable; only stored-source discovery adds
      // the linked clause's declaration.
      return Response.json({
        fields:
          templateId === TEMPLATE_ID
            ? [
                {
                  path: version === 1 ? "party" : "updatedParty",
                  kind: "string",
                  count: 1,
                  label:
                    version === 1 ? "Clause party" : "Updated clause party",
                  required: true,
                },
              ]
            : [],
        conditions: [],
        structureErrors: [],
      });
    }
    throw new TypeError(`Unexpected template form request: ${url.pathname}`);
  },
  { preconnect: originalFetch.preconnect },
);

const { cleanup, render, waitFor, fireEvent } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { default: messages } = await import("@/i18n/langs/en.json");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { TemplateForm } = await import("./template-form");
const { ClauseDriftPopover } =
  await import("@/routes/knowledge/-components/template-studio-inspector");
const { useTemplateFillSchema } = await import("./use-template-fill-schema");

afterAll(async () => {
  cleanup();
  globalThis.fetch = originalFetch;
  await GlobalRegistrator.unregister();
});

test("saved-template discovery supplies a required clause-only input to the mounted fill form", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const values: Record<string, unknown>[] = [];
  const FillPage = () => {
    const schema = useTemplateFillSchema(TEMPLATE_ID);
    if (schema.state !== "ready") {
      return <span>{schema.state}</span>;
    }
    return (
      <>
        <ClauseDriftPopover
          outdated={[linkedClause()]}
          templateId={TEMPLATE_ID}
        />
        <TemplateForm
          fields={schema.schema.fields}
          conditions={schema.schema.conditions}
          structureErrors={schema.schema.structureErrors}
          fileName={schema.fileName}
          templateId={TEMPLATE_ID}
          onBack={() => undefined}
          onDone={() => undefined}
          onValuesChange={(value) => {
            values.push(value);
          }}
        />
      </>
    );
  };
  const rootRoute = router.createRootRoute({ component: FillPage });
  const appRouter = router.createRouter({
    routeTree: rootRoute,
    history: router.createMemoryHistory({ initialEntries: ["/"] }),
    isServer: false,
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <AuthenticatedUserProvider
        user={{
          activeOrganizationId: "org-1",
          email: "member@example.test",
          id: "user-1",
          image: null,
          name: "Member",
          preferredName: null,
          timezoneId: "UTC",
          wordEditShortcut: null,
        }}
      >
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <FormattingProvider locale="en" timeZone="UTC">
            <router.RouterProvider router={appRouter} />
          </FormattingProvider>
        </IntlProvider>
      </AuthenticatedUserProvider>
    </QueryClientProvider>,
  );
  try {
    await waitFor(() =>
      expect(
        view.getByRole("textbox", { name: /Clause party/u }),
      ).toBeDefined(),
    );
    const input = view.getByRole("textbox", { name: /Clause party/u });
    if (!(input instanceof HTMLTextAreaElement)) {
      throw new TypeError("Expected clause-only text area");
    }
    expect(view.container.textContent).toContain("Clause party");
    expect(discoveredTemplateIds).toEqual([TEMPLATE_ID]);
    expect(requests).toContain("/v1/templates/discover");
    fireEvent.change(input, { target: { value: "Acme" } });
    await waitFor(() => expect(values.at(-1)?.["party"]).toBe("Acme"));
    expect(requests).not.toContain("/source.docx");
    fireEvent.click(view.getByRole("button", { name: /update/iu }));
    await waitFor(() =>
      expect(
        view.getByRole("button", { name: messages.clauses.syncAllOutdated }),
      ).toBeDefined(),
    );
    fireEvent.click(
      view.getByRole("button", { name: messages.clauses.syncAllOutdated }),
    );
    await syncStarted.promise;
    expect(view.getByRole("textbox", { name: /Clause party/u })).toBeDefined();
    sync.resolve(undefined);
    await waitFor(() =>
      expect(
        view.getByRole("textbox", { name: /Updated clause party/u }),
      ).toBeDefined(),
    );
    expect(discoveredTemplateIds.length).toBeGreaterThan(1);
    const discoveries = queryClient
      .getQueryCache()
      .findAll()
      .filter(
        (query) =>
          query.queryKey.at(-2) === "fill-discover" &&
          query.queryKey.at(-1) !== "",
      );
    expect(
      new Set(discoveries.map((query) => query.queryKey.at(-1))).size,
    ).toBe(2);
    expect(view.queryByRole("textbox", { name: /^Clause party/u })).toBeNull();
  } finally {
    view.unmount();
    queryClient.clear();
  }
});
