import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  type Mock,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as v from "valibot";

import { MODEL_RUN_CAP_CODES } from "@stll/api-contract/model-run-caps";
import { sleep } from "@stll/concurrency/sleep";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";
import { stellaToast } from "@stll/ui/toast";

import messages from "@/i18n/langs/en.json";
import type { WorkspaceFile } from "@/lib/workspaces/queries/entities";

GlobalRegistrator.register({ url: "http://localhost:3000" });
let respondLatest: (request: Request) => Promise<Response> | Response = () => {
  throw new TypeError("Unexpected status request");
};
let fetchBoundary: Mock<typeof globalThis.fetch>;
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { roleOptions } = await import("@/lib/auth-queries");
const { workspaceFilesOptions } =
  await import("@/lib/workspaces/queries/entities");
const { DocumentVerifications } = await import("./document-verifications");
const { sourceKindsOptions } = await import("./use-source-kinds");
const kindWrites: unknown[] = [];
/** Kind reads fail while this is above zero, one failure per read. */
let failingKindReads = 0;
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
  sizeBytes: 24_000,
} satisfies WorkspaceFile;
const clients: InstanceType<typeof QueryClient>[] = [];
const mountDocuments = (
  files: WorkspaceFile[],
  role: "admin" | "external" | "intern" | "member" | "owner" = "admin",
  kinds: "seeded" | "read" = "seeded",
) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
    },
  });
  clients.push(client);
  client.setQueryData(workspaceFilesOptions(workspaceId).queryKey, files);
  client.setQueryData(roleOptions.queryKey, role);
  // Every document starts as a record; the kind read is not what these
  // tests are about.
  const documentIds = files.map((file) => file.entityId);
  if (kinds === "seeded") {
    client.setQueryData(
      sourceKindsOptions({ workspaceId, listId, documentIds }).queryKey,
      new Map(documentIds.map((id) => [id, "document" as const])),
    );
  }
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
beforeEach(() => {
  fetchBoundary = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname.startsWith("/api/auth/")) {
          return Response.json(null);
        }
        if (
          request.method === "PATCH" &&
          new URL(request.url).pathname.endsWith("/source-documents")
        ) {
          const body: unknown = await request.json();
          kindWrites.push(body);
          return Response.json(body);
        }
        if (
          request.method === "POST" &&
          new URL(request.url).pathname.endsWith("/source-documents/kinds")
        ) {
          if (failingKindReads > 0) {
            failingKindReads -= 1;
            return Response.json(
              { message: "Kind read failed" },
              { status: 500 },
            );
          }
          // Read back after a write: what was last set, else a record.
          const { documentEntityIds } = v.parse(
            v.object({ documentEntityIds: v.array(v.string()) }),
            await request.json(),
          );
          const written = new Map(
            kindWrites.map((write) => {
              const { documentEntityId, sourceKind } = v.parse(
                v.object({
                  documentEntityId: v.string(),
                  sourceKind: v.string(),
                }),
                write,
              );
              return [documentEntityId, sourceKind];
            }),
          );
          return Response.json({
            documents: documentEntityIds.map((documentEntityId) => ({
              documentEntityId,
              sourceKind: written.get(documentEntityId) ?? "document",
            })),
          });
        }
        expect(request.method).toBe("POST");
        expect(new URL(request.url).pathname).toContain("/verifications");
        return await respondLatest(request);
      },
      { preconnect: () => undefined },
    ),
  );
});

afterEach(() => {
  mock.restore();
  cleanup();
  for (const client of clients.splice(0)) {
    client.clear();
  }
  fetchBoundary.mockClear();
  kindWrites.length = 0;
  failingKindReads = 0;
  respondLatest = () => {
    throw new TypeError("Unexpected status request");
  };
});
afterAll(async () => {
  // A settled mutation leaves React work scheduled; let it run while the DOM
  // globals still exist.
  await act(async () => {
    await sleep(50);
  });
  fetchBoundary.mockRestore();
  await unregisterDomEnvironment();
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
  const view = mountDocuments([document], "external");
  await waitFor(() =>
    expect(view.getByText(messages.avt.documents.notVerified)).toBeTruthy(),
  );
  expect(
    view
      .getByRole("button", { name: messages.common.verify })
      .hasAttribute("disabled"),
  ).toBe(true);
});

for (const code of Object.values(MODEL_RUN_CAP_CODES)) {
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
        code === MODEL_RUN_CAP_CODES.active
          ? messages.errors.apiCodes.runActiveLimitReached
          : messages.errors.apiCodes.runDailyLimitReached;
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
test("a document is marked as testimony through its switch", async () => {
  answerLatest(() => Response.json({ runs: [] }));
  const view = mountDocuments([document]);
  const toggle = view.getByRole("switch", {
    name: messages.avt.documents.testimony,
  });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(toggle);
  // The DOM test environment also forwards the click to the label's
  // control, so the same write can arrive twice; every write asks for
  // testimony.
  const write = {
    listId,
    documentEntityId: document.entityId,
    sourceKind: "testimony",
  };
  await waitFor(() => expect(kindWrites).toContainEqual(write));
  expect(kindWrites.every((sent) => Bun.deepEquals(sent, write))).toBe(true);
  expect(
    view
      .getByRole("switch", { name: messages.avt.documents.testimony })
      .getAttribute("aria-checked"),
  ).toBe("true");
});

test("a failed kind read says so where the switches are and recovers on retry", async () => {
  answerLatest(() => Response.json({ runs: [] }));
  failingKindReads = 1;
  const view = mountDocuments([document], "admin", "read");
  await waitFor(() =>
    expect(view.getByText(messages.avt.documents.kindsLoadFailed)).toBeTruthy(),
  );
  const toggle = () =>
    view.getByRole("switch", { name: messages.avt.documents.testimony });
  expect(Object.hasOwn(toggle().dataset, "disabled")).toBe(true);
  fireEvent.click(view.getByRole("button", { name: messages.common.retry }));
  // Polled assertions compare booleans: while the message is still shown, a
  // failing matcher on the DOM node formats the whole node graph, which
  // takes seconds per poll and starves the retry it is waiting for.
  await waitFor(() =>
    expect(
      view.queryByText(messages.avt.documents.kindsLoadFailed) === null,
    ).toBe(true),
  );
  await waitFor(() =>
    expect(Object.hasOwn(toggle().dataset, "disabled")).toBe(false),
  );
  expect(toggle().getAttribute("aria-checked")).toBe("false");
});
