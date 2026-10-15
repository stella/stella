import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
Object.assign(import.meta.env, { VITE_API_URL: "http://localhost:3001" });

const requests: Request[] = [];
const unexpectedRequests: string[] = [];
const answers: Response[] = [];
const fetchBoundary = spyOn(globalThis, "fetch").mockImplementation(
  Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.startsWith("/api/auth/")) {
        return Response.json(null);
      }
      if (
        request.method === "POST" &&
        new URL(request.url).pathname.endsWith("/verifications/latest")
      ) {
        return Response.json({ runs: [] });
      }
      if (
        request.method !== "POST" ||
        !new URL(request.url).pathname.endsWith("/verifications")
      ) {
        unexpectedRequests.push(`${request.method} ${request.url}`);
        return panic(`Unexpected request: ${request.method} ${request.url}`);
      }
      requests.push(request);
      const answer = answers.shift();
      if (answer === undefined) {
        return panic("No verification response seeded");
      }
      return answer;
    },
    { preconnect: () => undefined },
  ),
);

const { act, cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { createTranslator } = await import("use-intl/core");
const { stellaToast } = await import("@stll/ui/toast");
const { DocumentVerifications } = await import("./document-verifications");
const { latestVerificationsOptions } = await import("./queries");
const { roleOptions } = await import("@/lib/auth-queries");
const { workspaceFilesOptions } =
  await import("@/lib/workspaces/queries/entities");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { setTranslator } = await import("@/i18n/translator");
const english = (await import("@/i18n/langs/en.json")).default;
const czech = (await import("@/i18n/langs/cs.json")).default;

const workspaceId = "019a0000-0000-7000-8000-000000000001";
const listId = "019a0000-0000-7000-8000-000000000002";
const target = {
  entityId: "019a0000-0000-7000-8000-000000000003",
  fileFieldId: "019a0000-0000-7000-8000-000000000004",
};
const runId = "019a0000-0000-7000-8000-000000000005";
const clients: InstanceType<typeof QueryClient>[] = [];
const notice = spyOn(stellaToast, "add").mockReturnValue(
  "verification-refusal",
);

const mountDocuments = (locale: "en" | "cs" = "en") => {
  const messages = locale === "cs" ? czech : english;
  setTranslator(createTranslator({ locale, messages }));
  const opened: string[] = [];
  const client = new QueryClient({
    defaultOptions: {
      queries: { enabled: false, retry: false, gcTime: 0, staleTime: Infinity },
    },
  });
  clients.push(client);
  client.setQueryData(roleOptions.queryKey, "owner");
  client.setQueryData(workspaceFilesOptions(workspaceId).queryKey, [
    {
      entityId: target.entityId,
      fieldId: target.fileFieldId,
      name: "Drawdown statement",
      fileName: "drawdown.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      parentId: null,
    },
  ]);
  client.setQueryData(
    latestVerificationsOptions({ workspaceId, documents: [target] }).queryKey,
    new Map(),
  );
  render(
    <IntlProvider locale={locale} messages={messages} timeZone="UTC">
      <FormattingProvider locale={locale} timeZone="UTC">
        <QueryClientProvider client={client}>
          <DocumentVerifications
            workspaceId={workspaceId}
            listId={listId}
            onOpenRun={(id) => {
              opened.push(id);
            }}
          />
        </QueryClientProvider>
      </FormattingProvider>
    </IntlProvider>,
  );
  return { opened, messages };
};

const confirmation = () =>
  Response.json(
    {
      code: "usage_confirmation_required",
      message:
        "This run's estimated size needs an explicit confirmation to start.",
      confirmation: { estimatedUnits: 120, availableUnits: 500 },
    },
    { status: 428 },
  );

afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  for (const request of requests) {
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe(
      `/v1/lists/${workspaceId}/verifications`,
    );
  }
  requests.length = 0;
  expect(unexpectedRequests).toEqual([]);
  unexpectedRequests.length = 0;
  answers.length = 0;
  notice.mockClear();
  setTranslator(createTranslator({ locale: "en", messages: english }));
});
afterAll(async () => {
  // Let React's scheduled passive work finish before the DOM goes away.
  await act(async () => {
    await sleep(50);
  });
  notice.mockRestore();
  fetchBoundary.mockRestore();
  await unregisterDomEnvironment();
});

test("a large document starts only after confirming its displayed estimate", async () => {
  answers.push(confirmation(), Response.json({ runId }));
  const { opened, messages } = mountDocuments();
  fireEvent.click(screen.getByRole("button", { name: messages.common.verify }));
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByText(messages.avt.documents.sizeConfirmTitle),
  ).toBeTruthy();
  expect(dialog.textContent).toContain("120");
  expect(dialog.textContent).toContain("500");
  expect(requests).toHaveLength(1);
  expect(await requests.at(0)?.json()).toEqual({ listId, ...target });
  expect(opened).toEqual([]);
  fireEvent.click(
    within(dialog).getByRole("button", { name: messages.common.verify }),
  );
  await waitFor(() => expect(opened).toEqual([runId]));
  expect(requests).toHaveLength(2);
  expect(await requests.at(1)?.json()).toEqual({
    listId,
    ...target,
    confirmedUnits: 120,
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    screen.queryByText(messages.avt.documents.statusLoadFailed),
  ).toBeNull();
  expect(notice).not.toHaveBeenCalled();
});

test("cancelling a size confirmation abandons it and a fresh attempt needs confirmation again", async () => {
  answers.push(confirmation(), confirmation());
  const { opened, messages } = mountDocuments();
  fireEvent.click(screen.getByRole("button", { name: messages.common.verify }));
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: messages.common.cancel,
    }),
  );
  // Polled assertions compare booleans: a failing matcher on a DOM node
  // pretty-prints the whole document and stalls the event loop.
  await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
  expect(requests).toHaveLength(1);
  expect(opened).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: messages.common.verify }));
  await screen.findByRole("dialog");
  expect(requests).toHaveLength(2);
  expect(await requests.at(1)?.json()).toEqual({ listId, ...target });
  expect(opened).toEqual([]);
});

for (const refusal of [
  {
    name: "active run limit",
    message: "This organization has reached its active verification limit.",
  },
  {
    name: "daily run limit",
    message: "This organization has reached its daily verification limit.",
  },
]) {
  test(`the ${refusal.name} shows a localized refusal and permits another attempt`, async () => {
    answers.push(
      Response.json(
        {
          message: refusal.message,
          retryable: true,
          hint: "Retry later.",
        },
        { status: 429 },
      ),
      Response.json({ runId }),
    );
    const { opened, messages } = mountDocuments("cs");
    fireEvent.click(
      screen.getByRole("button", { name: messages.common.verify }),
    );
    await waitFor(() => expect(notice).toHaveBeenCalledTimes(1));
    expect(notice).toHaveBeenCalledWith({
      title: messages.avt.runs.startFailed,
      type: "error",
    });
    expect(opened).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(requests).toHaveLength(1);
    const verify = screen.getByRole("button", { name: messages.common.verify });
    expect(verify.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(verify);
    await waitFor(() => expect(opened).toEqual([runId]));
    expect(
      screen.queryByText(messages.avt.documents.statusLoadFailed),
    ).toBeNull();
    expect(requests).toHaveLength(2);
    expect(await requests.at(1)?.json()).toEqual({ listId, ...target });
  });
}
