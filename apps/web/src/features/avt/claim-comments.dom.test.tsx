import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
Object.assign(import.meta.env, { VITE_API_URL: "http://localhost:3001" });
type RecordedRequest = { method: string; path: string; body: unknown };
// Every product request must be one a test seeded a response for, so the
// assertions see exactly the comment traffic.
const requests: RecordedRequest[] = [];
const unexpectedRequests: string[] = [];
const answers: Response[] = [];
const fetchBoundary = spyOn(globalThis, "fetch").mockImplementation(
  Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const { pathname } = new URL(request.url);
      if (pathname.startsWith("/api/auth/")) {
        return Response.json(null);
      }
      const text = await request.text();
      requests.push({
        method: request.method,
        path: pathname,
        body: text === "" ? null : JSON.parse(text),
      });
      const answer = answers.shift();
      if (answer === undefined) {
        unexpectedRequests.push(`${request.method} ${pathname}`);
        return panic(
          `Unexpected network request: ${request.method} ${pathname}`,
        );
      }
      return answer;
    },
    { preconnect: () => undefined },
  ),
);
const { cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { ClaimComments } = await import("./claim-comments");
const { claimCommentsOptions } = await import("./claim-comments-query");
const { makeClaim, noCover } = await import("./avt.test-fixtures");
const messages = (await import("@/i18n/langs/en.json")).default;

const workspaceId = "0199a3c4-5b6d-7e8f-9a0b-000000009099";
const runId = "0199a3c4-5b6d-7e8f-9a0b-000000009097";
const organizationId = "org-claim-comments";
const me = {
  activeOrganizationId: organizationId,
  email: "reviewer@example.test",
  id: "user-reviewer",
  image: null,
  name: "Reviewer",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};
const claim = makeClaim({ suffix: 1, verdict: noCover });
const at = "2026-09-01T10:00:00.000Z";

const comment = ({
  id,
  body,
  mine,
  visibility = "private",
}: {
  id: string;
  body: string;
  mine: boolean;
  visibility?: "private" | "shared";
}) => ({
  authorId: mine ? me.id : "user-colleague",
  authorImage: null,
  authorName: mine ? "Reviewer" : "Colleague",
  blockAnchorId: "b1",
  body,
  color: null,
  createdAt: at,
  endOffset: 10,
  groupId: null,
  id,
  kind: "comment" as const,
  mine,
  quote: claim.text,
  startOffset: 0,
  style: null,
  updatedAt: at,
  visibility,
});
const page = (items: ReturnType<typeof comment>[]) =>
  Response.json({ items, limit: 100, nextCursor: null });

const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  const unexpected = unexpectedRequests.splice(0);
  const unused = answers.splice(0);
  requests.length = 0;
  expect(unexpected).toEqual([]);
  expect(unused).toHaveLength(0);
});
afterAll(async () => {
  fetchBoundary.mockRestore();
  await GlobalRegistrator.unregister();
});

const mount = (seeded: ReturnType<typeof comment>[]) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  client.setQueryData(
    claimCommentsOptions({
      claimId: claim.id,
      runId,
      viewer: { organizationId, userId: me.id },
      workspaceId,
    }).queryKey,
    seeded,
  );
  render(
    <IntlProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>
        <AuthenticatedUserProvider user={me}>
          <ClaimComments
            claim={claim}
            runId={runId}
            workspaceId={workspaceId}
          />
        </AuthenticatedUserProvider>
      </QueryClientProvider>
    </IntlProvider>,
  );
};

const commentsPath = `/v1/lists/${workspaceId}/claim-comments`;

test("a colleague's shared comment reads without controls; the reviewer's own can be edited and deleted", () => {
  mount([
    comment({
      id: "comment-colleague",
      body: "The minutes disagree.",
      mine: false,
      visibility: "shared",
    }),
    comment({ id: "comment-mine", body: "Check the minutes.", mine: true }),
  ]);
  expect(screen.getByText("The minutes disagree.")).toBeTruthy();
  expect(screen.getByText("Check the minutes.")).toBeTruthy();
  // One comment is the reviewer's: one edit and one delete control.
  expect(
    screen.getAllByRole("button", { name: messages.common.edit }),
  ).toHaveLength(1);
  expect(
    screen.getAllByRole("button", { name: messages.common.delete }),
  ).toHaveLength(1);
});

test("a reviewer adds, edits and deletes a comment on the selected claim", async () => {
  mount([]);
  expect(screen.getByText(messages.folio.comments.noComments)).toBeTruthy();

  const added = comment({
    id: "comment-new",
    body: "Ask for the minutes.",
    mine: true,
  });
  answers.push(Response.json({ groupId: null, id: added.id, ids: [added.id] }));
  answers.push(page([added]));
  fireEvent.click(screen.getByRole("button", { name: messages.folio.comment }));
  fireEvent.change(
    screen.getByRole("textbox", { name: messages.folio.comment }),
    { target: { value: "Ask for the minutes." } },
  );
  fireEvent.click(screen.getByRole("button", { name: messages.common.save }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests.at(0)).toEqual({
    method: "POST",
    path: commentsPath,
    body: {
      body: "Ask for the minutes.",
      claimId: claim.id,
      runId,
      visibility: "private",
    },
  });
  expect(requests.at(1)?.method).toBe("GET");
  await waitFor(() =>
    expect(screen.getByText("Ask for the minutes.")).toBeTruthy(),
  );
  requests.length = 0;

  answers.push(Response.json({ ok: true }));
  answers.push(page([{ ...added, body: "Ask for the signed minutes." }]));
  fireEvent.click(screen.getByRole("button", { name: messages.common.edit }));
  fireEvent.change(
    screen.getByRole("textbox", { name: messages.folio.comment }),
    { target: { value: "Ask for the signed minutes." } },
  );
  fireEvent.click(screen.getByRole("button", { name: messages.common.save }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests.at(0)).toEqual({
    method: "PATCH",
    path: `${commentsPath}/${added.id}`,
    body: { change: "body", body: "Ask for the signed minutes." },
  });
  await waitFor(() =>
    expect(screen.getByText("Ask for the signed minutes.")).toBeTruthy(),
  );
  requests.length = 0;

  answers.push(Response.json({ ok: true }));
  answers.push(page([]));
  fireEvent.click(screen.getByRole("button", { name: messages.common.delete }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests.at(0)).toMatchObject({
    method: "DELETE",
    path: `${commentsPath}/${added.id}`,
  });
  await waitFor(() =>
    expect(screen.getByText(messages.folio.comments.noComments)).toBeTruthy(),
  );
});
