import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import { VERIFICATION_RUN_CAP_CODES } from "@stll/api-contract/verification-run-caps";
import { stellaToast } from "@stll/ui/toast";

import messages from "@/i18n/langs/en.json";
import type { WorkspaceFile } from "@/lib/workspaces/queries/entities";

GlobalRegistrator.register({ url: "http://localhost:3000" });
let respondLatest: (request: Request) => Promise<Response> | Response = () => {
  throw new TypeError("Unexpected status request");
};
const fetchBoundary = spyOn(globalThis, "fetch").mockImplementation(
  Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.startsWith("/api/auth/")) {
        return Response.json(null);
      }
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toContain("/verifications");
      return await respondLatest(request);
    },
    { preconnect: () => undefined },
  ),
);
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { roleOptions } = await import("@/lib/auth-queries");
const { workspaceFilesOptions } =
  await import("@/lib/workspaces/queries/entities");
const { DocumentVerifications } = await import("./document-verifications");
const workspaceId = "019a0000-0000-7000-8000-000000000001";
const listId = "019a0000-0000-7000-8000-000000000002";
const document = {
  entityId: "019a0000-0000-7000-8000-000000000003",
  fieldId: "019a0000-0000-7000-8000-000000000004",
  name: "Service agreement",
  fileName: "agreement.docx",
  parentId: null,
  mimeType:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} satisfies WorkspaceFile;
const clients: InstanceType<typeof QueryClient>[] = [];
const mountDocuments = (
  files: WorkspaceFile[],
  role: "admin" | "external" | "intern" | "member" | "owner" = "admin",
) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
    },
  });
  clients.push(client);
  client.setQueryData(workspaceFilesOptions(workspaceId).queryKey, files);
  client.setQueryData(roleOptions.queryKey, role);
  return render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <QueryClientProvider client={client}>
          <DocumentVerifications
            workspaceId={workspaceId}
            listId={listId}
            onOpenRun={() => undefined}
          />
        </QueryClientProvider>
      </FormattingProvider>
    </IntlProvider>,
  );
};
const answerLatest = (
  respond: (request: Request) => Promise<Response> | Response,
) => {
  respondLatest = respond;
  fetchBoundary.mockClear();
  return fetchBoundary;
};
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) {
    client.clear();
  }
  fetchBoundary.mockClear();
  respondLatest = () => {
    throw new TypeError("Unexpected status request");
  };
});
afterAll(async () => {
  fetchBoundary.mockRestore();
  await GlobalRegistrator.unregister();
});
test("an empty matter shows its document empty state without requesting statuses", () => {
  const boundary = answerLatest(() => Response.json({ runs: [] }));
  const view = mountDocuments([]);
  expect(view.getByText(messages.avt.documents.empty)).toBeTruthy();
  expect(
    view.queryByRole("button", { name: messages.common.verify }),
  ).toBeNull();
  expect(boundary).not.toHaveBeenCalled();
});
test("pending statuses disable verification and show no unverified verdict", async () => {
  const { promise: response, resolve: finish } =
    Promise.withResolvers<Response>();
  answerLatest(async () => response);
  const view = mountDocuments([document]);
  expect(
    view
      .getByRole("button", { name: messages.common.verify })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(view.queryByText(messages.avt.documents.notVerified)).toBeNull();
  finish(Response.json({ runs: [] }));
  await waitFor(() =>
    expect(view.getByText(messages.avt.documents.notVerified)).toBeTruthy(),
  );
  expect(
    view
      .getByRole("button", { name: messages.common.verify })
      .hasAttribute("disabled"),
  ).toBe(false);
});
test("a status error offers retry, keeps verification disabled, and recovers", async () => {
  let failed = true;
  const boundary = answerLatest(() =>
    failed
      ? Response.json({ message: "Status read failed" }, { status: 500 })
      : Response.json({ runs: [] }),
  );
  const view = mountDocuments([document]);
  await waitFor(() =>
    expect(
      view.getByText(messages.avt.documents.statusLoadFailed),
    ).toBeTruthy(),
  );
  expect(
    view
      .getByRole("button", { name: messages.common.verify })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(view.queryByText(messages.avt.documents.notVerified)).toBeNull();
  failed = false;
  fireEvent.click(view.getByRole("button", { name: messages.common.retry }));
  await waitFor(() =>
    expect(view.getByText(messages.avt.documents.notVerified)).toBeTruthy(),
  );
  expect(view.queryByText(messages.avt.documents.statusLoadFailed)).toBeNull();
  expect(
    view
      .getByRole("button", { name: messages.common.verify })
      .hasAttribute("disabled"),
  ).toBe(false);
  expect(boundary).toHaveBeenCalledTimes(2);
});
test("a loaded document keeps verification disabled without update permission", async () => {
  answerLatest(() => Response.json({ runs: [] }));
  const view = mountDocuments([document], "viewer");
  await waitFor(() =>
    expect(view.getByText(messages.avt.documents.notVerified)).toBeTruthy(),
  );
  expect(
    view
      .getByRole("button", { name: messages.common.verify })
      .hasAttribute("disabled"),
  ).toBe(true);
});

for (const code of Object.values(VERIFICATION_RUN_CAP_CODES)) {
  test(`${code}: a limit refusal leaves the document available for a later verification`, async () => {
    const toast = spyOn(stellaToast, "add").mockReturnValue("limit-toast");
    try {
      answerLatest((request) =>
        new URL(request.url).pathname.endsWith("/latest")
          ? Response.json({ runs: [] })
          : Response.json(
              { code, message: "Server English text", retryable: true },
              { status: 429 },
            ),
      );
      const view = mountDocuments([document]);
      await waitFor(() =>
        expect(view.getByText(messages.avt.documents.notVerified)).toBeTruthy(),
      );
      fireEvent.click(
        view.getByRole("button", { name: messages.common.verify }),
      );
      const expected =
        code === VERIFICATION_RUN_CAP_CODES.active
          ? messages.errors.apiCodes.verificationActiveLimitReached
          : messages.errors.apiCodes.verificationDailyLimitReached;
      await waitFor(() =>
        expect(toast).toHaveBeenCalledWith(
          expect.objectContaining({ title: expected, type: "error" }),
        ),
      );
      expect(
        view
          .getByRole("button", { name: messages.common.verify })
          .hasAttribute("disabled"),
      ).toBe(false);
      expect(view.getByText(messages.avt.documents.notVerified)).toBeTruthy();
      expect(
        view.queryByRole("button", { name: messages.common.open }),
      ).toBeNull();
    } finally {
      toast.mockRestore();
    }
  });
}
