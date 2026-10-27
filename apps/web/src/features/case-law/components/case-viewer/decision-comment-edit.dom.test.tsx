import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import { toSafeId } from "@/lib/safe-id";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
Object.assign(import.meta.env, { VITE_API_URL: "http://localhost:3001" });
type RecordedRequest = { method: string; path: string; body: unknown };
// Every product request must be one a test seeded an answer for, so the
// assertions see exactly the annotation traffic.
const requests: RecordedRequest[] = [];
const unexpectedRequests: string[] = [];
// An answer may be held open, to look at the reader while a write is in
// flight.
const answers: (Response | Promise<Response>)[] = [];
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
const { act, cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { useRef } = await import("react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { stellaToast, ToastProvider } = await import("@stll/ui/toast");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { MarginNotes } = await import("@/components/legal-reader/margin-notes");
const { readerAnnotationsOptions } =
  await import("@/components/legal-reader/annotations/reader-annotations-query");
const { useDecisionAnnotationSurface } =
  await import("./use-decision-annotation-surface");
const messages = (await import("@/i18n/langs/en.json")).default;

const organizationId = "org-decision-comments";
const me = {
  activeOrganizationId: organizationId,
  email: "reader@example.test",
  id: "user-reader",
  image: null,
  name: "Reader",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};
const target = {
  type: "decision",
  caseNumber: "25 Cdo 1234/2025",
  caseNumberType: "case-number",
  country: "CZ",
  court: "Nejvyšší soud",
  decisionDate: "2025-06-01",
  decisionType: "rozsudek",
  ecli: null,
  id: "019b0121-9dd7-7000-8000-0000000000aa",
  name: null,
} as const;
const queryKey = readerAnnotationsOptions({
  activeOrganizationId: organizationId,
  targetId: target.id,
  targetType: target.type,
  userId: me.id,
}).queryKey;
const writtenAt = "2026-09-01T10:00:00.000Z";

const comment = ({
  id,
  body,
  mine,
}: {
  id: string;
  body: string;
  mine: boolean;
}) => ({
  authorId: mine ? me.id : "user-colleague",
  authorImage: null,
  authorName: mine ? "Reader" : "Colleague",
  blockAnchorId: "p-2",
  body,
  color: null,
  createdAt: writtenAt,
  endOffset: 24,
  groupId: null,
  id: toSafeId<"legalReaderAnnotation">(id),
  kind: "comment" as const,
  mine,
  quote: "the contract was void",
  startOffset: 3,
  style: null,
  updatedAt: writtenAt,
  visibility: mine ? ("private" as const) : ("shared" as const),
});
type Row = ReturnType<typeof comment>;
const page = (items: Row[]) =>
  Response.json({ items, limit: 100, nextCursor: null });

const own = comment({ id: "comment-own", body: "Check the date.", mine: true });
const colleagues = comment({
  id: "comment-colleague",
  body: "The appeal was late.",
  mine: false,
});
const ownPath = `/v1/reader/annotations/${own.id}`;
const EDIT = messages.legalReader.annotations.editComment;

const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(() => {
  // The toast manager outlives a render; one test's notice is not the next's.
  stellaToast.close();
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
  await unregisterDomEnvironment();
});

const DecisionComments = () => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const surface = useDecisionAnnotationSurface({
    marks: "all",
    scrollContainerRef,
    target,
  });
  return (
    <div ref={scrollContainerRef}>
      <MarginNotes items={surface.notes} placement="inline" />
    </div>
  );
};

const mount = (seeded: Row[]) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  client.setQueryData(queryKey, seeded);
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <QueryClientProvider client={client}>
        <FormattingProvider locale="en" timeZone="UTC">
          <AuthenticatedUserProvider user={me}>
            <ToastProvider>
              <DecisionComments />
            </ToastProvider>
          </AuthenticatedUserProvider>
        </FormattingProvider>
      </QueryClientProvider>
    </IntlProvider>,
  );
  return client;
};

const editor = () =>
  screen.getByRole("textbox", { name: messages.folio.comment });

test("only the reader's own comment offers Edit", () => {
  mount([colleagues, own]);

  expect(screen.getByText(colleagues.body)).toBeTruthy();
  expect(screen.getAllByRole("button", { name: EDIT })).toHaveLength(1);
  // The one Edit belongs to the card carrying the reader's own words.
  const button = screen.getByRole("button", { name: EDIT });
  expect(button.closest("[data-margin-note]")?.textContent).toContain(own.body);
});

test("a saved edit shows at once, keeps its passage, and holds once stored", async () => {
  const client = mount([own]);
  const { promise: stored, resolve: answerPatch } =
    Promise.withResolvers<Response>();
  answers.push(stored);

  fireEvent.click(screen.getByRole("button", { name: EDIT }));
  expect(editor().ownerDocument.activeElement).toBe(editor());
  expect(editor()).toHaveProperty("value", own.body);
  fireEvent.change(editor(), { target: { value: "Check the delivery date." } });
  fireEvent.keyDown(editor(), { key: "Enter", ctrlKey: true });

  // Before the server answers: the new words, marked edited, on the same
  // passage, and focus back on the button the edit started from.
  await waitFor(() =>
    expect(screen.getByText("Check the delivery date.")).toBeTruthy(),
  );
  expect(screen.queryByText(own.body)).toBeNull();
  expect(screen.getByText(messages.common.edited)).toBeTruthy();
  const editButton = screen.getByRole("button", { name: EDIT });
  expect(editButton.ownerDocument.activeElement).toBe(editButton);
  const optimistic = client.getQueryData(queryKey)?.at(0);
  expect(optimistic).toMatchObject({
    blockAnchorId: own.blockAnchorId,
    body: "Check the delivery date.",
    endOffset: own.endOffset,
    startOffset: own.startOffset,
  });
  // The cache is painted before the request leaves.
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests).toEqual([
    {
      method: "PATCH",
      path: ownPath,
      body: { change: "body", body: "Check the delivery date." },
    },
  ]);

  const saved = {
    ...own,
    body: "Check the delivery date.",
    updatedAt: "2026-09-01T10:05:00.000Z",
  };
  answers.push(page([saved]));
  await act(async () => answerPatch(Response.json({ ok: true })));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests.at(1)?.method).toBe("GET");
  await waitFor(() =>
    expect(client.getQueryData(queryKey)?.at(0)?.updatedAt).toBe(
      saved.updatedAt,
    ),
  );
  expect(screen.getByText("Check the delivery date.")).toBeTruthy();
  expect(screen.getByText(messages.common.edited)).toBeTruthy();
});

test("Escape leaves the comment as it was and returns focus to Edit", () => {
  mount([own]);

  fireEvent.click(screen.getByRole("button", { name: EDIT }));
  fireEvent.change(editor(), { target: { value: "Something else." } });
  fireEvent.keyDown(editor(), { key: "Escape" });

  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByText(own.body)).toBeTruthy();
  expect(screen.queryByText(messages.common.edited)).toBeNull();
  const editButton = screen.getByRole("button", { name: EDIT });
  expect(editButton.ownerDocument.activeElement).toBe(editButton);
  expect(requests).toEqual([]);
});

test("a save the server refuses puts the old words back and says so", async () => {
  mount([own]);
  answers.push(
    Response.json({ message: "Service unavailable" }, { status: 503 }),
  );
  answers.push(page([own]));

  fireEvent.click(screen.getByRole("button", { name: EDIT }));
  fireEvent.change(editor(), { target: { value: "Lost words." } });
  fireEvent.click(screen.getByRole("button", { name: messages.common.save }));

  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests.map(({ method }) => method)).toEqual(["PATCH", "GET"]);
  await waitFor(() => expect(screen.getByText(own.body)).toBeTruthy());
  expect(screen.queryByText("Lost words.")).toBeNull();
  expect(screen.queryByText(messages.common.edited)).toBeNull();
  expect(await screen.findByText(messages.errors.actionFailed)).toBeTruthy();
});

test("an emptied comment offers Delete instead of Save", async () => {
  mount([own]);
  answers.push(Response.json({ ok: true }));
  answers.push(page([]));

  fireEvent.click(screen.getByRole("button", { name: EDIT }));
  fireEvent.change(editor(), { target: { value: "   " } });

  expect(screen.queryByRole("button", { name: messages.common.save })).toBe(
    null,
  );
  fireEvent.click(screen.getByRole("button", { name: messages.common.delete }));

  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests.at(0)).toMatchObject({ method: "DELETE", path: ownPath });
  await waitFor(() => expect(screen.queryByText(own.body)).toBeNull());
});
