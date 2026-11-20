import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const opened: { entityId: string; label: string; workspaceId: string }[] = [];
const openDocument = async ({
  entityId,
  label,
  workspaceId,
}: {
  entityId: string;
  label: string;
  workspaceId: string;
}) => {
  opened.push({ entityId, label, workspaceId });
  return { type: "opened" as const };
};
const router = await import("@tanstack/react-router");
await mock.module("@tanstack/react-router", () => ({
  ...router,
  useRouter: () => ({ state: { matches: [] } }),
}));

const { cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const messages = (await import("@/i18n/langs/en.json")).default;
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { similarDocumentsKey } =
  await import("@/lib/workspaces/queries/similar-documents");
const { SimilarDocumentsSection } = await import("./similar-documents-section");

const WORKSPACE_ID = "0190a5d2-0000-7000-8000-000000000001";
const ENTITY_ID = "0190a5d2-0000-7000-8000-000000000002";
const SIGNED_ID = "0190a5d2-0000-7000-8000-000000000003";

const show = (
  documents: { entityId: string; entityName: string; similarity: number }[],
  { refetchFailed = false } = {},
) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  const queryKey = similarDocumentsKey(WORKSPACE_ID, ENTITY_ID);
  queryClient.setQueryData(queryKey, documents);
  if (refetchFailed) {
    queryClient
      .getQueryCache()
      .find({ queryKey })
      ?.setState({ status: "error", error: new Error("offline") });
  }
  render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en-GB" timeZone="UTC">
          <SimilarDocumentsSection
            entityId={ENTITY_ID}
            heading={(title) => <h2>{title}</h2>}
            openDocument={openDocument}
            workspaceId={WORKSPACE_ID}
          />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
};

afterEach(() => {
  cleanup();
  opened.length = 0;
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

test("lists each similar document with its estimated similarity", async () => {
  show([
    {
      entityId: SIGNED_ID,
      entityName: "Contract signed.pdf",
      similarity: 0.92,
    },
  ]);

  expect(
    await screen.findByRole("heading", {
      name: messages.inspector.metadata.similarDocuments.heading,
    }),
  ).toBeTruthy();
  expect(screen.getByText("Contract signed.pdf")).toBeTruthy();
  expect(screen.getByText("92% similar")).toBeTruthy();
});

test("opening a similar document opens it in the inspector", async () => {
  show([
    {
      entityId: SIGNED_ID,
      entityName: "Contract signed.pdf",
      similarity: 0.92,
    },
  ]);

  fireEvent.click(
    await screen.findByRole("button", { name: /Contract signed/u }),
  );

  expect(opened).toEqual([
    {
      entityId: SIGNED_ID,
      label: "Contract signed.pdf",
      workspaceId: WORKSPACE_ID,
    },
  ]);
});

test("a document with no similar documents shows no section", () => {
  show([]);

  expect(screen.queryByRole("heading")).toBeNull();
});

test("a failed refetch offers a retry beside the documents it still shows", () => {
  show(
    [
      {
        entityId: SIGNED_ID,
        entityName: "Contract signed.pdf",
        similarity: 0.9,
      },
    ],
    { refetchFailed: true },
  );

  expect(screen.getByRole("alert")).toBeDefined();
  expect(screen.getByText("Contract signed.pdf")).toBeDefined();
});

test("a failed refetch of an empty result still offers a retry", () => {
  show([], { refetchFailed: true });

  expect(screen.getByRole("heading")).toBeDefined();
  expect(screen.getByRole("alert")).toBeDefined();
});
