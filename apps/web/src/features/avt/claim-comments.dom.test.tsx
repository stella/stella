import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
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

import { toSafeId } from "@/lib/safe-id";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
Object.assign(import.meta.env, { VITE_API_URL: "http://localhost:3001" });
type RecordedRequest = {
  method: string;
  path: string;
  body: unknown;
  headers: Headers;
};
// Every product request must be one a test seeded a response for, so the
// assertions see exactly the comment traffic.
const requests: RecordedRequest[] = [];
const unexpectedRequests: string[] = [];
// An answer may be held open, to look at the UI while a request is in flight.
const answers: (Response | Promise<Response>)[] = [];
let fetchBoundary: Mock<typeof globalThis.fetch>;
const originalFetch = globalThis.fetch;
const fetchImplementation = Object.assign(
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
      headers: request.headers,
    });
    const answer = answers.shift();
    if (answer === undefined) {
      unexpectedRequests.push(`${request.method} ${pathname}`);
      return panic(`Unexpected network request: ${request.method} ${pathname}`);
    }
    return answer;
  },
  { preconnect: () => undefined },
);
globalThis.fetch = fetchImplementation;
const { cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { ClaimComments } = await import("./claim-comments");
const { ClaimDetailPanel } = await import("./claim-detail-panel");
const { useState } = await import("react");
const { roleOptions } = await import("@/lib/auth-queries");
const { FormattingProvider } = await import("@/i18n/formatting-context");
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
  id: toSafeId<"legalReaderAnnotation">(id),
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
beforeEach(() => {
  globalThis.fetch = fetchImplementation;
  fetchBoundary = spyOn(globalThis, "fetch").mockImplementation(
    fetchImplementation,
  );
});

afterEach(() => {
  mock.restore();
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
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
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
        <FormattingProvider locale="en" timeZone="UTC">
          <AuthenticatedUserProvider user={me}>
            <ClaimComments
              claim={claim}
              runId={runId}
              workspaceId={workspaceId}
            />
          </AuthenticatedUserProvider>
        </FormattingProvider>
      </QueryClientProvider>
    </IntlProvider>,
  );
};

// The test harness switch, not product copy.
const NEXT_CLAIM = "next claim";
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
    screen.getAllByRole("button", {
      name: messages.legalReader.annotations.editComment,
    }),
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
    headers: expect.anything(),
    path: commentsPath,
    body: {
      body: "Ask for the minutes.",
      claimId: claim.id,
      runId,
      visibility: "private",
    },
  });
  expect(requests.at(0)?.headers.get("Idempotency-Key")).toBeString();
  expect(requests.at(1)?.method).toBe("GET");
  await waitFor(() =>
    expect(screen.getByText("Ask for the minutes.")).toBeTruthy(),
  );
  requests.length = 0;

  answers.push(Response.json({ ok: true }));
  answers.push(page([{ ...added, body: "Ask for the signed minutes." }]));
  fireEvent.click(
    screen.getByRole("button", {
      name: messages.legalReader.annotations.editComment,
    }),
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: messages.folio.comment }),
    { target: { value: "Ask for the signed minutes." } },
  );
  fireEvent.click(screen.getByRole("button", { name: messages.common.save }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests.at(0)).toEqual({
    method: "PATCH",
    headers: expect.anything(),
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

test("editing and sharing a private comment stores its words before sharing them", async () => {
  const own = comment({ id: "comment-own", body: "Draft.", mine: true });
  mount([own]);
  const edit = () => {
    fireEvent.click(
      screen.getByRole("button", {
        name: messages.legalReader.annotations.editComment,
      }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: messages.folio.comment }),
      { target: { value: "Final." } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: messages.knowledge.agentSkills.scopePrivate,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: messages.common.save }));
  };

  // The words fail to store: nothing is shared.
  answers.push(Response.json({ message: "Unavailable" }, { status: 503 }));
  answers.push(page([own]));
  edit();
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests.map(({ method }) => method)).toEqual(["PATCH", "GET"]);
  expect(requests.at(0)?.body).toEqual({ change: "body", body: "Final." });
  requests.length = 0;

  // The words store first, then the comment is shared.
  const stored = { ...own, body: "Final." };
  answers.push(Response.json({ ok: true }));
  answers.push(page([stored]));
  answers.push(Response.json({ ok: true }));
  answers.push(page([{ ...stored, visibility: "shared" as const }]));
  edit();
  await waitFor(() => expect(requests).toHaveLength(4));
  expect(requests.map(({ method, body }) => [method, body])).toEqual([
    ["PATCH", { change: "body", body: "Final." }],
    ["GET", null],
    ["PATCH", { change: "visibility", visibility: "shared" }],
    ["GET", null],
  ]);
});

test("a comment still being stored offers no controls until the server answers", async () => {
  mount([]);
  const stored = comment({
    id: "comment-stored",
    body: "Ask for the minutes.",
    mine: true,
  });
  const { promise: created, resolve: answerCreate } =
    Promise.withResolvers<Response>();
  answers.push(created);
  fireEvent.click(screen.getByRole("button", { name: messages.folio.comment }));
  fireEvent.change(
    screen.getByRole("textbox", { name: messages.folio.comment }),
    { target: { value: "Ask for the minutes." } },
  );
  fireEvent.click(screen.getByRole("button", { name: messages.common.save }));
  await waitFor(() => expect(requests).toHaveLength(1));

  // The optimistic comment shows at once, with nothing to edit, delete or
  // share it by: the server has not given it an id yet.
  expect(screen.getByText("Ask for the minutes.")).toBeTruthy();
  for (const name of [
    messages.legalReader.annotations.editComment,
    messages.common.delete,
    messages.legalReader.annotations.visibilitySharedWithMatter,
  ]) {
    expect(screen.queryByRole("button", { name })).toBeNull();
  }
  expect(requests.map(({ method }) => method)).toEqual(["POST"]);

  answers.push(page([stored]));
  answerCreate(
    Response.json({ groupId: null, id: stored.id, ids: [stored.id] }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", {
        name: messages.legalReader.annotations.editComment,
      }),
    ).toBeTruthy(),
  );
  expect(
    screen.getByRole("button", { name: messages.common.delete }),
  ).toBeTruthy();
  expect(requests.map(({ method }) => method)).toEqual(["POST", "GET"]);
});

test("a comment being written on one claim is discarded when another claim is selected", () => {
  const next = makeClaim({ suffix: 2, verdict: noCover });
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  client.setQueryData(roleOptions.queryKey, "owner");
  for (const seeded of [claim, next]) {
    client.setQueryData(
      claimCommentsOptions({
        claimId: seeded.id,
        runId,
        viewer: { organizationId, userId: me.id },
        workspaceId,
      }).queryKey,
      [],
    );
  }
  const Panel = () => {
    const [selected, setSelected] = useState(claim);
    return (
      <>
        <button
          aria-label={NEXT_CLAIM}
          onClick={() => setSelected(next)}
          type="button"
        />
        <ClaimDetailPanel
          claim={selected}
          contested={new Set()}
          factsById={new Map()}
          onReviewEvent={() => undefined}
          runId={runId}
          stepper={{ current: null, total: 0, onPrev: null, onNext: null }}
          workspaceId={workspaceId}
        />
      </>
    );
  };
  render(
    <IntlProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>
        <FormattingProvider locale="en" timeZone="UTC">
          <AuthenticatedUserProvider user={me}>
            <Panel />
          </AuthenticatedUserProvider>
        </FormattingProvider>
      </QueryClientProvider>
    </IntlProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: messages.folio.comment }));
  fireEvent.change(
    screen.getByRole("textbox", { name: messages.folio.comment }),
    { target: { value: "Draft on the first claim." } },
  );
  fireEvent.click(screen.getByRole("button", { name: NEXT_CLAIM }));
  expect(
    screen.queryByRole("textbox", { name: messages.folio.comment }),
  ).toBeNull();
  expect(screen.queryByDisplayValue("Draft on the first claim.")).toBeNull();
  expect(screen.getByText(messages.folio.comments.noComments)).toBeTruthy();
  expect(requests).toEqual([]);
});
