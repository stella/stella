import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

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
const submittedFills: unknown[] = [];
const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  requests.push(url.pathname);
  if (url.pathname === `/v1/templates/${TEMPLATE_ID}/fill`) {
    if (typeof init?.body !== "string") {
      throw new TypeError("Expected JSON fill body");
    }
    submittedFills.push(JSON.parse(init.body));
    return Response.json({ message: "Fill unavailable" }, { status: 503 });
  }
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
                label: version === 1 ? "Clause party" : "Updated clause party",
                required: true,
              },
            ]
          : [],
      conditions: [],
      structureErrors: [],
    });
  }
  throw new TypeError(`Unexpected template form request: ${url.pathname}`);
};
globalThis.fetch = Object.assign(fakeFetch, {
  preconnect: originalFetch.preconnect,
});

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
  await unregisterDomEnvironment();
});

const renderFillPage = (children: ReactNode) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = router.createRootRoute({ component: () => children });
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
  return { view, queryClient };
};

test("saved-template discovery supplies a required clause-only input to the mounted fill form", async () => {
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
  const { view, queryClient } = renderFillPage(<FillPage />);
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

test("submitting restored values copies nested paths and preserves existing numeric and repeat values", async () => {
  submittedFills.length = 0;
  const restoredAddress = { city: "Prague" };
  const segments = Array.from(
    { length: 1024 },
    (_, index) => `section${index}`,
  );
  const deepPath = [...segments, "title"].join(".");
  const initialValues = {
    address: restoredAddress,
    "address.street": "Main",
    amount: " 12.5 ",
    scientific: "1e3",
    unbounded: "Infinity",
    approved: false,
    hidden: "not sent",
    show_hidden: false,
    "__array_signers.people": [0],
    "signers.people[0].address.city": "Brno",
    "signers.people[0].amount": "3",
    [deepPath]: "Deep clause",
    "section.": "not sent",
  };
  const { view, queryClient } = renderFillPage(
    <TemplateForm
      conditions={[]}
      fields={[
        { path: "address", kind: "string", count: 1 },
        { path: "address.street", kind: "string", count: 1 },
        { path: "amount", kind: "string", inputType: "number", count: 1 },
        { path: "scientific", kind: "string", inputType: "number", count: 1 },
        { path: "unbounded", kind: "string", inputType: "number", count: 1 },
        { path: "approved", kind: "boolean", count: 1 },
        {
          path: "hidden",
          kind: "string",
          visibleWhen: "show_hidden",
          count: 1,
        },
        {
          path: "signers.people",
          kind: "array",
          count: 1,
          itemFields: [
            { path: "address.city", kind: "string", count: 1 },
            { path: "amount", kind: "string", inputType: "number", count: 1 },
          ],
        },
        { path: deepPath, kind: "string", count: 1 },
        { path: "section.", kind: "string", count: 1 },
      ]}
      fileName="Restored_Contract.docx"
      initialValues={initialValues}
      onBack={() => undefined}
      onDone={() => undefined}
      structureErrors={[]}
      templateId={TEMPLATE_ID}
    />,
  );
  try {
    fireEvent.click(
      await view.findByRole("button", { name: messages.common.download }),
    );
    fireEvent.click(
      await view.findByRole("menuitem", {
        name: messages.templates.downloadDocx,
      }),
    );
    // A restored object value displays as an empty scalar; keep the real
    // optional-field confirmation in the submission path.
    fireEvent.click(
      await view.findByRole("button", {
        name: messages.templates.downloadAnyway,
      }),
    );
    await waitFor(() => expect(submittedFills.length).toBe(1));
    expect(restoredAddress).toEqual({ city: "Prague" });
    const submitted = submittedFills.at(0);
    expect(submitted).toMatchObject({
      values: {
        address: { city: "Prague", street: "Main" },
        amount: 12.5,
        scientific: 1000,
        // JSON transport preserves the existing Number("Infinity") serialization.
        unbounded: null,
        approved: false,
        "signers.people": [{ "address.city": "Brno", amount: 3 }],
      },
    });
    if (
      typeof submitted !== "object" ||
      submitted === null ||
      !("values" in submitted)
    ) {
      throw new TypeError("Expected submitted fill values");
    }
    let current: unknown = submitted.values;
    expect(current).not.toHaveProperty("hidden");
    expect(current).not.toHaveProperty("section");
    for (const segment of [...segments, "title"]) {
      if (typeof current !== "object" || current === null) {
        throw new TypeError("Submitted path ended before its field value");
      }
      current = Reflect.get(current, segment);
    }
    expect(current).toBe("Deep clause");
    expect(initialValues[deepPath]).toBe("Deep clause");
  } finally {
    submittedFills.length = 0;
    view.unmount();
    queryClient.clear();
  }
});
