import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { ExistingFileOrganizerDialog } =
  await import("@/routes/_protected.workspaces/$workspaceId/-components/existing-file-organizer-dialog");
const messages = (await import("@/i18n/langs/en.json")).default;

const originalFetch = globalThis.fetch;
const clients: InstanceType<typeof QueryClient>[] = [];
const workspaceId = "00000000-0000-4000-8000-000000000011";
const entityId = "00000000-0000-4000-8000-000000000013";
const files = [
  {
    entityId,
    originalName: "original.docx",
    parentId: null,
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
];

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  for (const client of clients.splice(0)) {
    client.clear();
  }
});
afterAll(unregisterDomEnvironment);

const Providers = ({
  children,
  client,
}: {
  children: ReactNode;
  client: InstanceType<typeof QueryClient>;
}) => (
  <IntlProvider locale="en" messages={messages}>
    <AuthenticatedUserProvider
      user={{
        id: "user",
        activeOrganizationId: "org",
        email: "reviewer@example.test",
        name: "Reviewer",
        image: null,
        preferredName: null,
        timezoneId: "Europe/Prague",
        wordEditShortcut: null,
      }}
    >
      <FormattingProvider locale="en" timeZone="UTC">
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </FormattingProvider>
    </AuthenticatedUserProvider>
  </IntlProvider>
);

const serveSuggestions = (
  respond: (path: string) => Response | Promise<Response>,
) => {
  const calls: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      calls.push(path);
      return await respond(path);
    },
    { preconnect: originalFetch.preconnect },
  );
  return calls;
};

const mountDialog = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const tree = (open: boolean) => (
    <Providers client={client}>
      <ExistingFileOrganizerDialog
        existingFolders={[]}
        files={files}
        onOpenChange={() => undefined}
        open={open}
        workspaceId={workspaceId}
      />
    </Providers>
  );
  const view = render(tree(true));
  return { view, setOpen: (open: boolean) => view.rerender(tree(open)) };
};

const generateButton = () =>
  [...document.body.querySelectorAll("button")].find((button) =>
    button.textContent.includes(messages.workspaces.importOrganizer.generateAi),
  );

test("reopening the dialog on the same files shows the cached AI suggestions without another call", async () => {
  const calls = serveSuggestions(() =>
    Response.json({
      suggestions: [
        {
          entityId,
          folderPath: "Reviewed",
          suggestedName: "reviewed.docx",
          detectedDate: null,
          documentType: "agreement",
        },
      ],
      deleteFolders: [],
    }),
  );
  const { setOpen } = mountDialog();
  const generate = await waitFor(() => {
    const button = generateButton();
    expect(button).toBeDefined();
    return button;
  });
  if (!generate) {
    throw new Error("Expected the generate button");
  }
  fireEvent.click(generate);
  await waitFor(() => {
    expect(document.body.innerHTML).toContain("reviewed.docx");
  });
  expect(generateButton()).toBeUndefined();

  setOpen(false);
  await waitFor(() => {
    expect(document.body.innerHTML).not.toContain("reviewed.docx");
  });
  setOpen(true);
  await waitFor(() => {
    expect(document.body.innerHTML).toContain("reviewed.docx");
  });
  expect(generateButton()).toBeUndefined();
  expect(calls.filter((path) => path.endsWith("organize-suggestions"))).toEqual(
    [`/v1/entities/${workspaceId}/organize-suggestions`],
  );
});

test("a failed AI call keeps offering a retry", async () => {
  serveSuggestions(() =>
    Response.json({ message: "unavailable" }, { status: 503 }),
  );
  mountDialog();
  const generate = await waitFor(() => {
    const button = generateButton();
    expect(button).toBeDefined();
    return button;
  });
  if (!generate) {
    throw new Error("Expected the generate button");
  }
  fireEvent.click(generate);
  await waitFor(() => {
    expect(document.body.textContent).toContain(
      messages.workspaces.importOrganizer.aiUnavailable,
    );
  });
  // Nothing moves the dialog out of the failed state on its own.
  await act(async () => {
    await Promise.resolve();
  });
  expect(document.body.textContent).toContain(
    messages.workspaces.importOrganizer.aiUnavailable,
  );
  expect(
    [...document.body.querySelectorAll("button")].some(
      (button) => button.textContent === messages.common.retry,
    ),
  ).toBe(true);
});

test("reopening the dialog while an apply is running cannot start a second one", async () => {
  const writes = Promise.withResolvers<Response>();
  const calls = serveSuggestions(async (path) =>
    path.endsWith("organize-suggestions")
      ? Response.json({
          suggestions: [
            {
              entityId,
              folderPath: "Reviewed",
              suggestedName: "reviewed.docx",
              detectedDate: null,
              documentType: "agreement",
            },
          ],
          deleteFolders: [],
        })
      : await writes.promise,
  );
  const { setOpen } = mountDialog();
  const generate = await waitFor(() => {
    const button = generateButton();
    expect(button).toBeDefined();
    return button;
  });
  if (!generate) {
    throw new Error("Expected the generate button");
  }
  fireEvent.click(generate);
  await waitFor(() => {
    expect(document.body.innerHTML).toContain("reviewed.docx");
  });
  const writeCalls = () =>
    calls.filter((path) => !path.endsWith("organize-suggestions"));
  const applyButton = () =>
    [...document.body.querySelectorAll("button")].find(
      (button) =>
        button.textContent === messages.workspaces.importOrganizer.apply,
    );
  const first = await waitFor(() => {
    const button = applyButton();
    expect(button).toBeDefined();
    return button;
  });
  if (!first) {
    throw new Error("Expected the apply button");
  }
  fireEvent.click(first);
  await waitFor(() => expect(writeCalls().length).toBeGreaterThan(0));
  const started = writeCalls().length;

  setOpen(false);
  await waitFor(() => {
    expect(document.body.innerHTML).not.toContain("reviewed.docx");
  });
  setOpen(true);
  const second = await waitFor(() => {
    const button = applyButton();
    expect(button).toBeDefined();
    return button;
  });
  if (!second) {
    throw new Error("Expected the apply button after reopening");
  }
  fireEvent.click(second);
  await act(async () => {
    await Promise.resolve();
  });
  expect(writeCalls()).toHaveLength(started);
  await act(async () => {
    writes.resolve(Response.json({ entityId }));
    await Promise.resolve();
  });
});
