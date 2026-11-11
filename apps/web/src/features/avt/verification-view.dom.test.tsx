import * as React from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { panic } from "better-result";
import { plugin } from "bun";
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

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import type { FolioScrollEventDetail } from "@/lib/folio-scroll-event";

import type { OriginalDocxHostProps } from "./original-docx-host";
import type {
  ClaimState,
  ListItem,
  ReviewHistoryEntry,
  ReviewHistoryPage,
  VerificationRun,
} from "./types";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

// The build turns a `?worker&url` import into the emitted worker's URL; the
// original view's chunk only holds on to the file viewer's.
plugin({
  name: "worker-url",
  setup(build) {
    build.onLoad({ filter: /\?worker&url$/u }, () => ({
      contents: 'export default "/worker.js";',
      loader: "js",
    }));
  },
});
Object.assign(import.meta.env, { VITE_API_URL: "http://localhost:3001" });
type RecordedRequest = { method: string; path: string; body: unknown };
// Background auth reads are answered and ignored; every other request must be
// one a test seeded a response for, so assertions see only product traffic.
const requests: RecordedRequest[] = [];
const unexpectedRequests: string[] = [];
const answers: (Response | Promise<Response>)[] = [];
let fetchBoundary: Mock<typeof globalThis.fetch>;
const { act, cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react");
const { EditorState } = await import("@tiptap/pm/state");
const { EditorView } = await import("@tiptap/pm/view");
const { schema } = await import("@stll/folio-core/prosemirror");
const { createFolioAIEditSnapshot } = await import("@stll/folio-core/ai-edits");

const { OriginalDocxHostContext } = await import("./original-docx-host");
const { FOLIO_SCROLL_EVENT } = await import("@/lib/folio-scroll-event");

// Folio's host, faked where the original view takes its file viewer: it
// delivers the test's document to the `docxPlugins` the view hands the
// viewer, as Folio does on load, and paints the document's text as body runs
// carrying their ProseMirror positions. Real Folio pages neither load nor lay
// out under happy-dom.
let hostDocument: ProseMirrorNode | null = null;
// While set, the host is still loading its file, as the real viewer is
// before its query resolves.
let hostLoading: Promise<void> | null = null;
// The blocks the host was asked to scroll to. Like the real viewer, it hears
// scroll requests only once it is mounted.
const hostScrolls: FolioScrollEventDetail[] = [];
const FakeFolioHost = ({ docxPlugins, fieldId }: OriginalDocxHostProps) => {
  if (hostLoading !== null) {
    React.use(hostLoading);
  }
  const doc = hostDocument ?? panic("No document for the fake Folio host.");
  const plugins =
    docxPlugins ?? panic("The original view must hand Folio its plugins.");
  const paint = (node: HTMLDivElement | null) => {
    if (node === null) {
      return undefined;
    }
    const onScroll = (event: CustomEvent<FolioScrollEventDetail>) => {
      if (event.detail.fieldId === fieldId) {
        hostScrolls.push(event.detail);
      }
    };
    window.addEventListener(FOLIO_SCROLL_EVENT, onScroll);
    const content = document.createElement("div");
    content.className = "layout-page-content";
    doc.descendants((child, pos) => {
      if (child.isText && child.text !== undefined) {
        const run = document.createElement("span");
        run.dataset["pmStart"] = String(pos);
        run.dataset["pmEnd"] = String(pos + child.text.length);
        run.textContent = child.text;
        content.append(run);
      }
    });
    node.replaceChildren(content);
    // A real editor view over the document, which hands it to the host
    // plugins as Folio's does.
    const view = new EditorView(document.createElement("div"), {
      state: EditorState.create({ doc, plugins: [...plugins] }),
    });
    return () => {
      view.destroy();
      window.removeEventListener(FOLIO_SCROLL_EVENT, onScroll);
    };
  };
  return <div ref={paint} />;
};
const renderFakeFolioHost = (props: OriginalDocxHostProps) => (
  <FakeFolioHost {...props} />
);
const {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} = await import("@tanstack/react-router");
const { QueryClient, QueryClientProvider, useQuery } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { roleOptions } = await import("@/lib/auth-queries");
const { avtKeys, reviewHistoryOptions, verificationRunOptions } =
  await import("./queries");
const { toSafeId } = await import("@/lib/safe-id");
const { fileOptions } = await import("@/lib/files/queries");
const { workspaceFilesOptions } =
  await import("@/lib/workspaces/queries/entities");
const { useInspectorCommandStore } =
  await import("@/components/inspector/inspector-command-store");
const { PDF_CLAIM_BOX_ATTRIBUTE } = await import("./original-pdf-claim-box");
const { PDF } = await import("@libpdf/core");
const { VerificationView } = await import("./verification-view");
const { STATE_META } = await import("./types");
const { EMPTY_CLAIM_REVIEW } = await import("./claim-review.logic");
const {
  makeClaim,
  makeRun,
  makeFact,
  factId,
  supported,
  contradicted,
  noCover,
  notVerifiable,
  recordConflict,
  WITNESS_STATEMENT_MARKED_TEXT,
  witnessStatementRun,
} = await import("./avt.test-fixtures");
const messages = (await import("@/i18n/langs/en.json")).default;
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const workspaceId = "0199a3c4-5b6d-7e8f-9a0b-000000009099";
const actorId = "0199a3c4-5b6d-7e8f-9a0b-000000009098";
const viewer = {
  id: actorId,
  activeOrganizationId: "organization",
  email: "reviewer@example.test",
  image: null,
  name: "Reviewer",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};
const at = "2026-09-01T10:00:00Z";
const clients: InstanceType<typeof QueryClient>[] = [];
beforeEach(() => {
  fetchBoundary = spyOn(globalThis, "fetch").mockImplementation(
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
        return await answer;
      },
      { preconnect: () => undefined },
    ),
  );
});

afterEach(() => {
  mock.restore();
  cleanup();
  hostDocument = null;
  hostLoading = null;
  hostScrolls.length = 0;
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

const claimFixtures = {
  supported: {
    claim: makeClaim({
      suffix: 1,
      verdict: supported(),
      refs: [{ factEntityId: factId(1), rel: "supports" }],
    }),
    text: "The parties signed the agreement in July.",
    label: "Supported",
  },
  tension: {
    claim: makeClaim({
      suffix: 2,
      verdict: { state: "tension", score: 50, recordConflict: null },
      refs: [
        { factEntityId: factId(1), rel: "supports" },
        { factEntityId: factId(2), rel: "conflicts" },
      ],
    }),
    text: "The drawdown occurred during July.",
    label: "In tension",
  },
  contradicted: {
    claim: makeClaim({
      suffix: 3,
      verdict: contradicted(),
      refs: [{ factEntityId: factId(2), rel: "conflicts" }],
    }),
    text: "No payment was made in August.",
    label: "Contradicted",
  },
  nocover: {
    claim: makeClaim({ suffix: 4, verdict: noCover }),
    text: "The lender delivered written notice in June.",
    label: "No coverage",
  },
  recordconflict: {
    claim: makeClaim({ suffix: 5, verdict: recordConflict }),
    text: "The drawdown took place on 5 July 2021.",
    label: "Record conflict",
  },
  notverifiable: {
    claim: makeClaim({ suffix: 6, verdict: notVerifiable, type: "opinion" }),
    text: "The lender acted unfairly.",
    label: "Not verifiable",
  },
} satisfies Record<
  ClaimState,
  { claim: VerificationRun["claims"][number]; text: string; label: string }
>;

const seededRun = () => {
  const claims = Object.values(claimFixtures).map(({ claim, text }) => ({
    ...claim,
    text,
    anchor: {
      type: "docx-block",
      blockId: `b${String(claim.position)}`,
      start: 0,
      end: text.length,
    } as const,
  }));
  const run = makeRun(claims, [
    makeFact(1, { text: "The signed agreement provides for July drawdown." }),
    makeFact(2, { text: "The bank statement records an August drawdown." }),
    makeFact(5, { text: "The signed drawdown request is dated 5 July 2021." }),
    makeFact(6, { text: "The transfer receipt records 28 July 2021." }),
  ]);
  return {
    ...run,
    blocks: claims.map(
      ({ position, text }) =>
        ({
          ordinal: position,
          blockId: `b${String(position)}`,
          kind: "docx-block",
          pageNumber: null,
          text,
        }) satisfies VerificationRun["blocks"][number],
    ),
  };
};

const SeededVerification = ({ runId }: { runId: string }) => {
  const { data } = useQuery(verificationRunOptions(workspaceId, runId));
  return data === undefined ? null : (
    <VerificationView workspaceId={workspaceId} run={data} />
  );
};

/** `signedIn` mounts the view with its viewer, so the reads made per
 *  viewer (comments, the list's facts) run as they do in the app. */
const mount = async (run: VerificationRun = seededRun(), signedIn = false) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { enabled: false, retry: false },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  client.setQueryData(roleOptions.queryKey, "owner");
  client.setQueryData(
    verificationRunOptions(workspaceId, run.id).queryKey,
    run,
  );
  const root = createRootRoute({ component: Outlet });
  const protectedRoute = createRoute({
    getParentRoute: () => root,
    id: "_protected",
    beforeLoad: () => ({ user: { id: actorId } }),
    component: Outlet,
  });
  const home = createRoute({
    getParentRoute: () => protectedRoute,
    path: "/",
    component: () => <SeededVerification runId={run.id} />,
  });
  const router = createRouter({
    routeTree: root.addChildren([protectedRoute.addChildren([home])]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const view = (
    <QueryClientProvider client={client}>
      <OriginalDocxHostContext value={renderFakeFolioHost}>
        <RouterProvider router={router} />
      </OriginalDocxHostContext>
    </QueryClientProvider>
  );
  render(
    <IntlProvider locale="en" messages={messages}>
      <FormattingProvider locale="en" timeZone="UTC">
        {signedIn ? (
          <AuthenticatedUserProvider user={viewer}>
            {view}
          </AuthenticatedUserProvider>
        ) : (
          view
        )}
      </FormattingProvider>
    </IntlProvider>,
  );
  return { client, run };
};

const claimButton = (suffix: number) => {
  const fixture = Object.values(claimFixtures).find(
    ({ claim }) => claim.position === suffix,
  );
  if (fixture === undefined) {
    panic(`Missing claim fixture ${String(suffix)}`);
  }
  return screen.getByRole("button", {
    name: (name) => name.startsWith(fixture.text),
  });
};
const selectClaim = (suffix: number) => fireEvent.click(claimButton(suffix));

/** Type a reason into the inline field and press Enter. Shift+Enter is a
 *  line break first, so only the plain Enter can send it. */
const giveReason = (label: string, reason: string) => {
  const field = screen.getByLabelText(label);
  fireEvent.change(field, { target: { value: reason } });
  const sent = requests.length;
  fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
  expect(requests.length).toBe(sent);
  fireEvent.keyDown(field, { key: "Enter" });
};

test("the reader draws each stored block with its claims marked on the stored words", async () => {
  const { run } = await mount(witnessStatementRun());
  const marks = run.claims.map((claim) => {
    const mark = document.querySelector<HTMLElement>(`#avt-claim-${claim.id}`);
    if (mark === null) {
      return panic(`Missing claim mark ${claim.id}`);
    }
    return mark;
  });
  // The reader paragraph is keyed by the stored block id, and its text is the
  // stored text, so a claim's mark covers exactly the words it was anchored on.
  for (const stored of run.blocks) {
    const paragraph = document.querySelector<HTMLElement>(
      `[data-anchor="${stored.blockId}"]`,
    );
    expect(paragraph?.tagName).toBe("P");
    expect(
      paragraph?.textContent.startsWith(stored.text.slice(0, 20)) === true,
    ).toBe(true);
  }
  expect(
    // The button is the control; the span inside it draws the mark and
    // holds the words.
    marks.map((mark) =>
      [...(mark.firstElementChild?.childNodes ?? mark.childNodes)]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join(""),
    ),
  ).toEqual([...WITNESS_STATEMENT_MARKED_TEXT]);
  // The first claim in reading order starts selected; clicking another
  // selects it and opens its detail.
  expect(marks.at(0)?.getAttribute("aria-pressed")).toBe("true");
  const opinion = marks.at(5);
  if (opinion === undefined) {
    panic("Missing opinion claim mark");
  }
  fireEvent.click(opinion);
  expect(opinion.getAttribute("aria-pressed")).toBe("true");
  expect(marks.at(0)?.getAttribute("aria-pressed")).toBe("false");
  expect(
    screen
      .getAllByText("In my view the lender acted unfairly.")
      .some((node) => node.tagName === "BLOCKQUOTE"),
  ).toBe(true);
  expect(requests).toEqual([]);
});

test("all verdicts expose their evidence and basis in the real detail panel, never a score", async () => {
  const { run } = await mount();
  const seededStates: string[] = run.claims.map(({ verdict }) => verdict.state);
  expect(seededStates.toSorted()).toEqual(Object.keys(STATE_META).toSorted());
  for (const { claim, text, label } of Object.values(claimFixtures)) {
    const suffix = claim.position;
    selectClaim(suffix);
    expect(claimButton(suffix).getAttribute("aria-pressed")).toBe("true");
    expect(claimButton(suffix).textContent).toContain(label);
    const quote = screen
      .getAllByText(text)
      .find((node) => node.tagName === "BLOCKQUOTE");
    if (quote?.parentElement === null || quote?.parentElement === undefined) {
      panic("Missing selected detail heading");
    }
    expect(within(quote.parentElement).getByText(label)).toBeTruthy();
    // The verdict shows as its category only; the score stays in the API.
    if (claim.verdict.score !== null) {
      expect(screen.queryByText(String(claim.verdict.score))).toBeNull();
    }
    if (suffix === 1) {
      expect(
        screen.getByText("The signed agreement provides for July drawdown."),
      ).toBeTruthy();
    }
    if (suffix === 4) {
      expect(screen.getByText(messages.avt.disposition.nocover)).toBeTruthy();
    }
    if (suffix === 6) {
      expect(screen.getByText("Not a verifiable assertion.")).toBeTruthy();
    }
    if (suffix === 5) {
      expect(
        screen.getByText(messages.avt.claimDetail.basis.verdictWithheld),
      ).toBeTruthy();
      expect(screen.getByText("5 July 2021")).toBeTruthy();
      expect(screen.getByText("28 July 2021")).toBeTruthy();
    }
  }
  expect(requests).toEqual([]);
});

test("a claim's qualifiers show beside its verdict and in its detail, and a silent record reads muted", async () => {
  const silentText = "I would have expected the board to minute it.";
  const widenedText = "I was on leave for the whole of August 2021.";
  const silent = {
    ...makeClaim({
      suffix: 1,
      verdict: noCover,
      qualifiers: [
        {
          kind: "record-silent",
          explanation:
            "The witness's own expectation; no minute would record it.",
          review: "routine",
        },
      ],
    }),
    text: silentText,
  };
  const widened = {
    ...makeClaim({
      suffix: 2,
      verdict: { state: "tension", score: 48, recordConflict: null },
      refs: [{ factEntityId: factId(1), rel: "conflicts" }],
      qualifiers: [
        {
          kind: "scope-mismatch",
          explanation: "The calendar covers 2 to 20 August only.",
          review: "needs-judgement",
        },
        { kind: "unsourced-only", explanation: null, review: "routine" },
        { kind: "rests-on-held", explanation: null, review: "needs-judgement" },
      ],
    }),
    text: widenedText,
  };
  const gap = {
    ...makeClaim({ suffix: 3, verdict: noCover }),
    text: "The lender delivered written notice in June.",
  };
  const claims = [silent, widened, gap].map((claim) => ({
    ...claim,
    anchor: {
      type: "docx-block",
      blockId: `b${String(claim.position)}`,
      start: 0,
      end: claim.text.length,
    } as const,
  }));
  await mount({
    ...makeRun(claims, [makeFact(1, { text: "Leave 2–20 August 2021." })]),
    blocks: claims.map(({ position, text }) => ({
      ordinal: position,
      blockId: `b${String(position)}`,
      kind: "docx-block" as const,
      pageNumber: null,
      text,
    })),
  });
  const mark = (text: string) =>
    screen.getByRole("button", { name: (name) => name.startsWith(text) });
  const detail = () => {
    const heading = screen
      .getAllByText((_, node) => node?.tagName === "BLOCKQUOTE")
      .at(0)?.parentElement;
    return heading ?? panic("Missing detail heading");
  };

  // The silent record reads muted in the document and its chip says why;
  // it is not offered as a gap to fill.
  expect(mark(silentText).firstElementChild?.className).toContain(
    "text-muted-foreground",
  );
  expect(mark(silentText).textContent).toContain(
    messages.avt.qualifiers.recordSilent.label,
  );
  fireEvent.click(mark(silentText));
  expect(
    within(detail()).getByText(messages.avt.states.nocover.silentChip),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "The witness's own expectation; no minute would record it.",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(messages.avt.disposition.nocover)).toBeNull();

  // Plain missing coverage is a gap at full strength, said in one line.
  expect(mark(gap.text).firstElementChild?.className).not.toContain(
    "text-muted-foreground",
  );
  fireEvent.click(mark(gap.text));
  expect(screen.getByText(messages.avt.disposition.nocover)).toBeTruthy();

  // Every other qualifier is a chip beside the verdict. The detail adds a
  // line only for what the grader said; a rule is its chip's tooltip.
  fireEvent.click(mark(widenedText));
  for (const label of [
    messages.avt.qualifiers.scopeMismatch.label,
    messages.avt.qualifiers.unsourcedOnly.label,
    messages.avt.qualifiers.restsOnHeld.label,
  ]) {
    expect(within(detail()).getAllByText(label).length).toBeGreaterThan(0);
  }
  const notes = screen.getByRole("list", {
    name: messages.avt.qualifiers.heading,
  });
  expect(
    within(notes).getByText("The calendar covers 2 to 20 August only."),
  ).toBeTruthy();
  expect(
    within(notes).queryByText(messages.avt.qualifiers.unsourcedOnly.hint),
  ).toBeNull();
  expect(
    within(notes).queryByText(messages.avt.qualifiers.restsOnHeld.hint),
  ).toBeNull();
  expect(screen.queryByText("48")).toBeNull();
  // The fact card shows the same footing: it has no linked source, whatever
  // its medium says.
  expect(screen.getByText(messages.avt.factTier.unsourced.label)).toBeTruthy();
  // What a claim type means is a tooltip on its chip, not panel prose.
  expect(screen.queryByText(messages.avt.claimTypes.fact.hint)).toBeNull();
  expect(requests).toEqual([]);
});

test("single review reduces the attention queue while bulk acceptance only settles routine claims", async () => {
  const { client, run } = await mount();
  expect(screen.getByText("0/3")).toBeTruthy();
  const claim = run.claims.at(1);
  expect(claim).toBeDefined();
  if (claim === undefined) {
    panic("Missing seeded tension claim");
  }
  const reviewed = {
    ...EMPTY_CLAIM_REVIEW,
    status: "reviewed",
    statusOrigin: "single",
    decidedAt: at,
    decidedBy: actorId,
  } as const;
  answers.push(Response.json({ claimId: claim.id, review: reviewed }));
  fireEvent.click(
    screen.getByRole("button", { name: messages.avt.verification.showQueue }),
  );
  expect(claimButton(2).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(
    screen.getByRole("button", { name: messages.avt.confirm.verdict }),
  );
  await waitFor(() =>
    expect(
      client
        .getQueryData(verificationRunOptions(workspaceId, run.id).queryKey)
        ?.claims.at(1)?.review,
    ).toEqual(reviewed),
  );
  expect(screen.getByText("1/3")).toBeTruthy();
  expect(requests.at(0)?.body).toEqual({
    runId: run.id,
    claimId: claim.id,
    event: { kind: "status", status: "reviewed" },
  });
  const routine = run.claims.filter(
    ({ verdict }) =>
      verdict.state === "supported" ||
      verdict.state === "nocover" ||
      verdict.state === "notverifiable",
  );
  const bulkReview = { ...reviewed, statusOrigin: "bulk" } as const;
  answers.push(
    Response.json({
      reviews: routine.map(({ id }) => ({ claimId: id, review: bulkReview })),
    }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Accept 3 routine claims" }),
  );
  // Polled assertions compare booleans: a failing matcher on a DOM node
  // pretty-prints the whole document and stalls the event loop.
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: /^Accept .*routine claim/u }) ===
        null,
    ).toBe(true),
  );
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests.at(1)?.body).toEqual({
    runId: run.id,
    claimIds: routine.map(({ id }) => id),
  });
  const cached = client.getQueryData(
    verificationRunOptions(workspaceId, run.id).queryKey,
  );
  for (const index of [2, 4]) {
    expect(cached?.claims.at(index)?.review).toBeNull();
  }
  await waitFor(() =>
    expect(
      client
        .getQueryData(verificationRunOptions(workspaceId, run.id).queryKey)
        ?.claims.at(5)?.review,
    ).toEqual(bulkReview),
  );
  selectClaim(6);
  expect(screen.getByText(/^Accepted as routine/u)).toBeTruthy();
});

test("a governing record changes the verdict and escalation keeps the conflict open with review disabled", async () => {
  const { client, run } = await mount();
  selectClaim(5);
  const claim = run.claims.at(4);
  if (claim === undefined) {
    panic("Missing seeded record conflict claim");
  }
  const governed = {
    ...EMPTY_CLAIM_REVIEW,
    recordConflictResolution: { kind: "governed", factEntityId: factId(5) },
    decidedAt: at,
    decidedBy: actorId,
  } as const;
  answers.push(Response.json({ claimId: claim.id, review: governed }));
  const governingButton = screen
    .getAllByRole("button", {
      name: messages.avt.claimDetail.recordConflict.treatAsGoverningRecord,
    })
    .at(0);
  if (governingButton === undefined) {
    panic("Missing governing record action");
  }
  fireEvent.click(governingButton);
  // Governing changes the verdict, so nothing is sent until the reviewer
  // says why: a blank reason is refused next to the field, and Escape steps
  // back without recording anything.
  giveReason(messages.avt.reason.govern, "   ");
  expect(screen.getByText(messages.avt.reason.required)).toBeTruthy();
  fireEvent.keyDown(screen.getByLabelText(messages.avt.reason.govern), {
    key: "Escape",
  });
  expect(screen.queryByLabelText(messages.avt.reason.govern)).toBeNull();
  expect(requests).toEqual([]);
  fireEvent.click(governingButton);
  giveReason(messages.avt.reason.govern, "  The signed request governs. ");
  await waitFor(() =>
    expect(
      client
        .getQueryData(verificationRunOptions(workspaceId, run.id).queryKey)
        ?.claims.at(4)?.review,
    ).toEqual(governed),
  );
  expect(requests.at(0)).toEqual({
    method: "POST",
    path: `/v1/lists/${workspaceId}/claim-reviews`,
    body: {
      runId: run.id,
      claimId: claim.id,
      event: {
        kind: "record-conflict",
        resolution: { kind: "governed", factEntityId: factId(5) },
        reason: "The signed request governs.",
      },
    },
  });
  expect(claimButton(5).textContent).toContain("Supported");
  expect(screen.getByText("0/2")).toBeTruthy();
  expect(
    screen.getByText(messages.avt.claimDetail.basis.verdictWithheld),
  ).toBeTruthy();
  expect(screen.getAllByText("5 July 2021").length).toBeGreaterThan(0);
  expect(screen.getByText("28 July 2021")).toBeTruthy();
  const escalated = {
    ...EMPTY_CLAIM_REVIEW,
    recordConflictResolution: { kind: "escalated" },
    decidedAt: at,
    decidedBy: actorId,
  } as const;
  answers.push(Response.json({ claimId: claim.id, review: escalated }));
  fireEvent.click(
    screen.getByRole("button", {
      name: messages.avt.claimDetail.recordConflict.flagForEvidenceTeam,
    }),
  );
  giveReason(messages.avt.reason.escalate, "Both records need the originals.");
  await waitFor(() =>
    expect(
      screen.getByText(messages.avt.claimDetail.recordConflict.escalatedNotice),
    ).toBeTruthy(),
  );
  await waitFor(() =>
    expect(
      client
        .getQueryData(verificationRunOptions(workspaceId, run.id).queryKey)
        ?.claims.at(4)?.review,
    ).toEqual(escalated),
  );
  expect(requests.at(1)).toEqual({
    method: "POST",
    path: `/v1/lists/${workspaceId}/claim-reviews`,
    body: {
      runId: run.id,
      claimId: claim.id,
      event: {
        kind: "record-conflict",
        resolution: { kind: "escalated" },
        reason: "Both records need the originals.",
      },
    },
  });
  expect(
    screen
      .getByRole("button", { name: messages.avt.confirm.recordConflict })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(claimButton(5).textContent).toContain("Record conflict");
  expect(screen.getByText("0/3")).toBeTruthy();
  expect(
    screen.getByText(messages.avt.claimDetail.basis.verdictWithheld),
  ).toBeTruthy();
  expect(screen.getByText("5 July 2021")).toBeTruthy();
  expect(screen.getByText("28 July 2021")).toBeTruthy();
});

test("a document's record is pre-selected over a witness's account, and the reviewer still confirms it", async () => {
  const run = seededRun();
  const withSuggestion = {
    ...run,
    claims: run.claims.map((claim) =>
      claim.position === 5
        ? { ...claim, suggestedGoverningFactId: factId(6) }
        : claim,
    ),
  };
  const { client } = await mount(withSuggestion);
  selectClaim(5);
  const claim = withSuggestion.claims.at(4);
  if (claim === undefined) {
    panic("Missing seeded record conflict claim");
  }

  // The suggestion is shown, not applied: the verdict stays withheld and
  // nothing is sent until the reviewer confirms.
  expect(
    screen.getByText(messages.avt.claimDetail.recordConflict.suggestedNotice),
  ).toBeTruthy();
  expect(screen.getByText(messages.common.suggested)).toBeTruthy();
  expect(claimButton(5).textContent).toContain("Record conflict");
  expect(requests).toEqual([]);
  const confirm = screen.getByRole("button", {
    name: messages.avt.claimDetail.recordConflict.confirmGoverningRecord,
  });
  // The other record keeps its plain action.
  expect(
    screen.getAllByRole("button", {
      name: messages.avt.claimDetail.recordConflict.treatAsGoverningRecord,
    }),
  ).toHaveLength(1);

  const governed = {
    ...EMPTY_CLAIM_REVIEW,
    recordConflictResolution: { kind: "governed", factEntityId: factId(6) },
    decidedAt: at,
    decidedBy: actorId,
  } as const;
  answers.push(Response.json({ claimId: claim.id, review: governed }));
  fireEvent.click(confirm);
  // Confirming the suggestion still sets the verdict, so it takes a reason.
  giveReason(messages.avt.reason.govern, "The bank ledger is the record.");
  await waitFor(() =>
    expect(
      client
        .getQueryData(
          verificationRunOptions(workspaceId, withSuggestion.id).queryKey,
        )
        ?.claims.at(4)?.review,
    ).toEqual(governed),
  );
  expect(requests).toEqual([
    {
      method: "POST",
      path: `/v1/lists/${workspaceId}/claim-reviews`,
      body: {
        runId: withSuggestion.id,
        claimId: claim.id,
        event: {
          kind: "record-conflict",
          resolution: { kind: "governed", factEntityId: factId(6) },
          reason: "The bank ledger is the record.",
        },
      },
    },
  ]);
  // Once chosen, the suggestion is no longer shown as one.
  expect(
    screen.queryByText(messages.avt.claimDetail.recordConflict.suggestedNotice),
  ).toBeNull();
});

test("a verdict resting only on testimony says so beside it and in its sign-off", async () => {
  const text = "The ward was told of the change on 3 May.";
  const claim = {
    ...makeClaim({
      suffix: 1,
      verdict: supported(),
      refs: [{ factEntityId: factId(1), rel: "supports" }],
      qualifiers: [
        { kind: "testimony-only", explanation: null, review: "routine" },
      ],
    }),
    text,
    anchor: {
      type: "docx-block",
      blockId: "b1",
      start: 0,
      end: text.length,
    } as const,
  };
  const run = makeRun([claim], [makeFact(1, { text: "Told on 3 May." })]);
  await mount({
    ...run,
    factStandings: [
      {
        factEntityId: factId(1),
        scoring: "included" as const,
        tier: "testimony" as const,
      },
    ],
    blocks: [
      {
        ordinal: 1,
        blockId: "b1",
        kind: "docx-block" as const,
        pageNumber: null,
        text,
      },
    ],
  });
  fireEvent.click(
    screen.getByRole("button", { name: (name) => name.startsWith(text) }),
  );
  expect(
    screen.getAllByText(messages.avt.qualifiers.testimonyOnly.label).length,
  ).toBeGreaterThan(0);
  // Its rule is the chip's tooltip, not a line in the panel.
  expect(
    screen.queryByText(messages.avt.qualifiers.testimonyOnly.hint),
  ).toBeNull();
  expect(screen.getByText(messages.avt.disposition.testimonyOnly)).toBeTruthy();
  // The fact card names its footing.
  expect(screen.getByText(messages.avt.factTier.testimony.label)).toBeTruthy();
  expect(requests).toEqual([]);
});

test("a rejected review restores the claim and attention queue and surfaces the failed save", async () => {
  const { client, run } = await mount();
  selectClaim(2);
  const pendingReview = Promise.withResolvers<Response>();
  answers.push(pendingReview.promise);
  fireEvent.click(
    screen.getByRole("button", { name: messages.avt.confirm.verdict }),
  );
  await waitFor(() => expect(screen.getByText("1/3")).toBeTruthy());
  expect(claimButton(2).textContent).toContain("reviewed");
  await waitFor(() => expect(requests).toHaveLength(1));
  pendingReview.resolve(
    Response.json(
      { code: "INTERNAL_SERVER_ERROR", message: "Review service unavailable" },
      { status: 500 },
    ),
  );
  await waitFor(() =>
    expect(screen.getByText(messages.avt.save.failed)).toBeTruthy(),
  );
  expect(screen.getByText("0/3")).toBeTruthy();
  expect(
    client
      .getQueryData(verificationRunOptions(workspaceId, run.id).queryKey)
      ?.claims.at(1)?.review,
  ).toBeNull();
  expect(claimButton(2).textContent).not.toContain("reviewed");
  expect(
    screen
      .getByRole("button", { name: messages.avt.confirm.verdict })
      .hasAttribute("disabled"),
  ).toBe(false);
});

test("a DOCX and a PDF verification both offer their original beside the reading view", async () => {
  await mount();
  const views = messages.avt.verification.documentView;
  expect(
    screen
      .getByRole("tablist", { name: views.label })
      .textContent.includes(views.original),
  ).toBe(true);
  expect(
    screen
      .getByRole("tab", { name: views.reading })
      .getAttribute("aria-selected"),
  ).toBe("true");
  cleanup();

  const docx = seededRun();
  await mount({
    ...docx,
    claims: docx.claims.map((claim) => ({
      ...claim,
      anchor: {
        type: "pdf-page" as const,
        pageNumber: claim.position,
        start: claim.anchor.start,
        end: claim.anchor.end,
      },
    })),
    blocks: docx.blocks.map((block) => ({
      ...block,
      kind: "pdf-page" as const,
      pageNumber: block.ordinal,
    })),
  });
  expect(
    screen
      .getByRole("tablist", { name: views.label })
      .textContent.includes(views.original),
  ).toBe(true);
  expect(
    screen
      .getByRole("tab", { name: views.reading })
      .getAttribute("aria-selected"),
  ).toBe("true");
  expect(claimButton(1).getAttribute("aria-pressed")).toBe("true");
  expect(requests).toEqual([]);
});

const nextFrame = async () => {
  await act(
    async () =>
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      }),
  );
};

const paintedRun = (text: string) =>
  [...document.querySelectorAll<HTMLElement>(".layout-page-content span")].find(
    (span) => span.textContent === text,
  ) ?? panic(`Missing painted run: ${text}`);

test("the original locates claims in the document Folio loads, and a click on a claim's painted words selects it", async () => {
  const doc = schema.node("doc", undefined, [
    schema.node("paragraph", { paraId: "1A2B3C4D" }, [
      schema.text("The lease was signed on 3 March 2021."),
    ]),
    schema.node("paragraph", { paraId: "5E6F7A8B" }, [
      schema.text("Rent fell due monthly."),
    ]),
  ]);
  const blocks = createFolioAIEditSnapshot(doc).blocks.map(
    (block, ordinal): VerificationRun["blocks"][number] => ({
      ordinal,
      blockId: block.id,
      kind: "docx-block",
      pageNumber: null,
      text: block.text,
    }),
  );
  const lease = blocks[0] ?? panic("Expected two stored blocks");
  const rent = blocks[1] ?? panic("Expected two stored blocks");
  const anchored = (
    suffix: number,
    verdict: VerificationRun["claims"][number]["verdict"],
    block: VerificationRun["blocks"][number],
  ) => ({
    ...makeClaim({
      suffix,
      verdict,
      anchor: {
        type: "docx-block",
        blockId: block.blockId,
        start: 0,
        end: block.text.length,
      },
    }),
    text: block.text,
  });
  const unplaced = {
    ...makeClaim({
      suffix: 3,
      verdict: noCover,
      anchor: { type: "docx-block", blockId: "absent", start: 0, end: 6 },
    }),
    text: "Notice was never served.",
  };
  hostDocument = doc;
  await mount({
    ...makeRun([
      anchored(1, supported(), lease),
      anchored(2, contradicted(), rent),
      unplaced,
    ]),
    blocks,
  });
  const views = messages.avt.verification.documentView;
  const readingClaim = (text: string) =>
    screen.getByRole("button", { name: (name) => name.startsWith(text) });

  fireEvent.click(screen.getByRole("tab", { name: views.original }));
  // Claims are resolved only once the plugin has the loaded document: the
  // one anchored outside it is then listed under the pages.
  const unplacedButton = await screen.findByRole("button", {
    name: (name) => name.startsWith(unplaced.text),
  });
  expect(
    screen.getByText("1 claim was not located in the original"),
  ).toBeTruthy();
  expect(unplacedButton.getAttribute("aria-pressed")).toBe("false");

  // happy-dom lays nothing out: each claim's words report one box.
  const getClientRects = spyOn(
    Range.prototype,
    "getClientRects",
  ).mockImplementation(function (this: Range) {
    const box = this.toString().startsWith("Rent")
      ? new DOMRect(100, 80, 120, 16)
      : new DOMRect(100, 40, 120, 16);
    return Object.assign([box], { item: () => box });
  });
  try {
    // The ranges are rebuilt on the frame after the claims are placed.
    await nextFrame();
    // A click beside the words selects nothing.
    fireEvent.click(paintedRun(rent.text), { clientX: 10, clientY: 88 });
    fireEvent.click(screen.getByRole("tab", { name: views.reading }));
    expect(readingClaim(lease.text).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("tab", { name: views.original }));
    await screen.findByText("1 claim was not located in the original");
    await nextFrame();
    // A click on a claim's painted words selects that claim.
    fireEvent.click(paintedRun(rent.text), { clientX: 150, clientY: 88 });
  } finally {
    getClientRects.mockRestore();
  }
  fireEvent.click(screen.getByRole("tab", { name: views.reading }));
  expect(readingClaim(rent.text).getAttribute("aria-pressed")).toBe("true");
  expect(readingClaim(lease.text).getAttribute("aria-pressed")).toBe("false");
});

test("a step taken while the original is still loading scrolls the viewer once it has the document", async () => {
  hostDocument = schema.node("doc", undefined, [
    schema.node("paragraph", undefined, [schema.text("The deed.")]),
  ]);
  let finishLoading = () => {};
  hostLoading = new Promise<void>((resolve) => {
    finishLoading = resolve;
  });
  const claims = [1, 2].map((suffix) =>
    makeClaim({ suffix, verdict: contradicted() }),
  );
  const run = {
    ...makeRun(claims, []),
    blocks: claims.map((claim): VerificationRun["blocks"][number] => ({
      ordinal: claim.position,
      blockId: `b${String(claim.position)}`,
      kind: "docx-block",
      pageNumber: null,
      text: claim.text,
    })),
  };
  await mount(run);
  const contradictedTile =
    screen
      .getAllByRole("button")
      .find(
        (button) =>
          button.textContent === `2${claimFixtures.contradicted.label}`,
      ) ?? panic("Missing the contradicted tile");
  fireEvent.click(contradictedTile);
  fireEvent.click(
    screen.getByRole("tab", {
      name: messages.avt.verification.documentView.original,
    }),
  );

  // The viewer is still loading; the stepper already moves the selection.
  const [nextMatch] = await screen.findAllByRole("button", {
    name: messages.common.nextMatch,
  });
  fireEvent.click(nextMatch ?? panic("Missing the next-match button"));
  expect(hostScrolls).toEqual([]);

  await act(async () => {
    finishLoading();
    await hostLoading;
  });
  await waitFor(() => {
    expect(hostScrolls).toEqual([{ blockId: "b2", fieldId: run.fileFieldId }]);
  });
});

/** The seeded run, its claims anchored on the pages of a PDF. */
const seededPdfRun = (): VerificationRun => {
  const run = seededRun();
  return {
    ...run,
    claims: run.claims.map((claim) => ({
      ...claim,
      anchor: {
        type: "pdf-page" as const,
        pageNumber: 1,
        start: claim.anchor.start,
        end: claim.anchor.end,
      },
    })),
    blocks: [
      {
        ordinal: 0,
        blockId: "p1",
        kind: "pdf-page" as const,
        pageNumber: 1,
        text: run.claims.map((claim) => claim.text).join("\n"),
      },
    ],
  };
};

const seedPdfFile = async (
  client: InstanceType<typeof QueryClient>,
  run: VerificationRun,
  bytes: Uint8Array,
) => {
  client.setQueryData(
    fileOptions({
      workspaceId,
      fieldId: run.fileFieldId,
      purpose: "display",
    }).queryKey,
    {
      fileId: "0199a3c4-5b6d-7e8f-9a0b-000000009097",
      fileName: "statement.pdf",
      mimeType: "application/pdf",
      originalMimeType: "application/pdf",
      buffer: bytes.slice().buffer,
    },
  );
};

const onePagePdf = async () => {
  const pdf = PDF.create();
  pdf
    .addPage({ size: "letter" })
    .drawText("The parties signed the agreement in July.", {
      x: 72,
      y: 700,
      size: 12,
    });
  return await pdf.save();
};

const openOriginal = () => {
  fireEvent.click(
    screen.getByRole("tab", {
      name: messages.avt.verification.documentView.original,
    }),
  );
};

test("the original PDF mounts its viewer and claim boxes inside the PDF store", async () => {
  // happy-dom lays nothing out: the pane reports a width to fit the pages to.
  const clientWidth =
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth") ??
    panic("happy-dom defines clientWidth");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 640,
  });
  // What the viewer's error boundaries caught. PDF.js cannot draw pages
  // under happy-dom, so the file viewer itself reports a failed load; what
  // must never reach a boundary is a viewer part read outside its store.
  const caught: unknown[] = [];
  const consoleError = spyOn(console, "error").mockImplementation(
    (...args: unknown[]) => {
      caught.push(...args.filter((arg) => arg instanceof Error));
    },
  );
  try {
    const run = seededPdfRun();
    const { client } = await mount(run);
    await seedPdfFile(client, run, await onePagePdf());
    openOriginal();
    await nextFrame();
    await nextFrame();
    expect(document.querySelector("[data-avt-original-pdf]")).not.toBeNull();
    await waitFor(() => {
      expect(
        client
          .getQueryCache()
          .findAll({ queryKey: ["pdf-document"] })
          .map((query) => query.queryKey.at(-1)),
      ).toContain("document");
    });
    expect(
      caught.filter(
        (error) =>
          error instanceof Error && error.message.includes("PDFProvider"),
      ),
    ).toEqual([]);
  } finally {
    consoleError.mockRestore();
    Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
  }
});

test("going to a PDF claim whose box is drawn leaves the scrolling to the box", async () => {
  const run = seededPdfRun();
  await mount(run);
  const requested: number[] = [];
  const { requestPdfPageScroll } = useInspectorCommandStore.getState();
  useInspectorCommandStore.setState({
    requestPdfPageScroll: ({ pageNumber }) => {
      requested.push(pageNumber);
    },
  });
  const boxes: HTMLElement[] = [];
  try {
    // A selected claim, so opening the original goes to it.
    fireEvent.click(
      document.querySelector<HTMLButtonElement>(
        'button[aria-pressed="false"]',
      ) ?? panic("Missing a verdict tile"),
    );

    // No box drawn yet: the page is requested, and the box follows it.
    openOriginal();
    expect(requested).toEqual([1]);

    // Every claim's box is drawn: only the box scrolls, no page request.
    for (const claim of run.claims) {
      const box = document.createElement("div");
      box.setAttribute(PDF_CLAIM_BOX_ATTRIBUTE, claim.id);
      document.body.append(box);
      boxes.push(box);
    }
    fireEvent.click(
      screen.getByRole("tab", {
        name: messages.avt.verification.documentView.reading,
      }),
    );
    openOriginal();
    expect(requested).toEqual([1]);
  } finally {
    for (const box of boxes) {
      box.remove();
    }
    useInspectorCommandStore.setState({ requestPdfPageScroll });
  }
});

test("page text that cannot be read shows a retryable failure, not every claim as not located", async () => {
  const run = seededPdfRun();
  const { client } = await mount(run);
  // The page texts are read as soon as the original opens.
  client.setQueryDefaults(avtKeys.all(workspaceId), { enabled: true });
  // Bytes no PDF reader accepts: the page-text read fails.
  await seedPdfFile(client, run, new TextEncoder().encode("not a pdf"));
  openOriginal();

  const failure = await screen.findByRole("alert");
  expect(failure.textContent).toContain(
    messages.avt.verification.pdfTextFailed,
  );
  expect(screen.queryByText(/not located in the original/u)).toBeNull();

  const pagesQuery = () =>
    client
      .getQueryCache()
      .findAll({
        queryKey: [...avtKeys.all(workspaceId), "original-pdf-pages"],
      })
      .at(0)?.state;
  const failuresBefore = pagesQuery()?.errorUpdateCount ?? 0;
  fireEvent.click(
    within(failure).getByRole("button", { name: messages.common.retry }),
  );
  await waitFor(() => {
    expect(pagesQuery()?.errorUpdateCount).toBe(failuresBefore + 1);
  });
  expect(screen.getByRole("alert").textContent).toContain(
    messages.avt.verification.pdfTextFailed,
  );
});

test("needs evidence keeps a claim open, gets its own queue filter, and stays out of routine acceptance", async () => {
  const { client, run } = await mount();
  expect(
    screen.getByRole("button", { name: "Accept 3 routine claims" }),
  ).toBeTruthy();
  selectClaim(4);
  const claim = run.claims.at(3) ?? panic("Missing seeded no-coverage claim");
  const needsEvidence = {
    ...EMPTY_CLAIM_REVIEW,
    status: "needs-evidence",
    statusOrigin: "single",
    decidedAt: at,
    decidedBy: actorId,
    eventCount: 1,
  } as const;
  answers.push(Response.json({ claimId: claim.id, review: needsEvidence }));
  fireEvent.click(
    screen.getByRole("button", {
      name: messages.avt.review.status.needsEvidence,
    }),
  );
  await waitFor(() =>
    expect(
      client
        .getQueryData(verificationRunOptions(workspaceId, run.id).queryKey)
        ?.claims.at(3)?.review,
    ).toEqual(needsEvidence),
  );
  expect(requests.at(0)?.body).toEqual({
    runId: run.id,
    claimId: claim.id,
    event: { kind: "status", status: "needs-evidence" },
  });
  // Not a decision: the claim is still open, so routine acceptance leaves it
  // to whoever marked it.
  expect(
    screen.getByRole("button", { name: "Accept 2 routine claims" }),
  ).toBeTruthy();
  const filter = screen.getByRole("button", {
    name: `${messages.avt.review.status.needsEvidence} 1`,
  });
  selectClaim(1);
  fireEvent.click(filter);
  expect(filter.getAttribute("aria-pressed")).toBe("true");
  // The filter takes the reader to the claim it lists.
  expect(claimButton(4).getAttribute("aria-pressed")).toBe("true");
});

test("a claim's history opens from one row and reads who did what, why, and what changed", async () => {
  const seeded = seededRun();
  const claimIndex = 2;
  const target = seeded.claims.at(claimIndex) ?? panic("Missing claim");
  const run = {
    ...seeded,
    claims: seeded.claims.map((claim, index) =>
      index === claimIndex
        ? {
            ...claim,
            review: {
              ...EMPTY_CLAIM_REVIEW,
              override: "supported",
              decidedAt: at,
              decidedBy: actorId,
              eventCount: 2,
            },
          }
        : claim,
    ),
  } satisfies VerificationRun;
  const { client } = await mount(run);
  const entry = (
    id: number,
    fields: Pick<
      ReviewHistoryEntry,
      "actor" | "action" | "reason" | "before" | "after"
    >,
  ): ReviewHistoryEntry => ({
    id: toSafeId<"legalListClaimReviewEvent">(
      `0199a3c4-5b6d-7e8f-9a0b-00000000710${String(id)}`,
    ),
    claimId: target.id,
    kind: fields.action.kind,
    createdAt: `2026-09-0${String(id)}T10:00:00.000Z`,
    ...fields,
  });
  const page = {
    items: [
      entry(2, {
        actor: {
          type: "member",
          id: actorId,
          name: "Dana Reviewer",
          image: null,
        },
        action: { kind: "override", state: "supported" },
        reason: { type: "given", text: "The later ledger entry corrects it." },
        before: { verdict: "contradicted", override: "tension", status: null },
        after: { verdict: "contradicted", override: "supported", status: null },
      }),
      entry(1, {
        actor: { type: "former" },
        action: { kind: "override", state: "tension" },
        reason: { type: "unrecorded" },
        before: { verdict: "contradicted", override: null, status: null },
        after: { verdict: "contradicted", override: "tension", status: null },
      }),
    ],
    nextCursor: null,
    limit: 50,
    reviewers: {
      type: "complete",
      items: [{ id: actorId, name: "Dana Reviewer", image: null }],
    },
  } satisfies ReviewHistoryPage;
  client.setQueryData(
    reviewHistoryOptions({ workspaceId, runId: run.id, claimId: target.id })
      .queryKey,
    { pages: [page], pageParams: [null] },
  );
  selectClaim(3);
  const toggle = screen.getByRole("button", { name: /^History/u });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.textContent).toContain("2");
  expect(screen.queryByText("Dana Reviewer")).toBeNull();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("Dana Reviewer")).toBeTruthy();
  expect(screen.getByText(messages.avt.history.formerMember)).toBeTruthy();
  expect(
    screen.getAllByText(messages.avt.history.actions.overridden),
  ).toHaveLength(2);
  expect(screen.getByText("The later ledger entry corrects it.")).toBeTruthy();
  expect(screen.getByText(messages.avt.history.reasonUnrecorded)).toBeTruthy();
  // The newest entry reads the verdict it found and the one it left.
  const newest = screen.getByText("Dana Reviewer").closest("li");
  const changes = within(newest ?? panic("No history entry")).getAllByText(
    /^(In tension|Supported)$/u,
  );
  expect(changes.map((badge) => badge.textContent)).toEqual([
    messages.avt.states.tension.chip,
    messages.avt.states.supported.chip,
  ]);
  expect(requests).toEqual([]);
});

const listFact = (suffix: number, name: string): ListItem => ({
  id: factId(suffix),
  name,
  itemType: "fact",
  status: "open",
  priority: "none",
  dueDate: null,
  sectionId: null,
  position: `a${String(suffix)}`,
  description: null,
  reviewStatus: "unreviewed",
  createdAt: "2026-10-01T12:00:00Z",
  updatedAt: "2026-10-01T12:00:00Z",
  customFields: [],
  firstSource: null,
  sourceTier: "unsourced",
  factDetails: null,
});

test("a gap claim leads with adding or linking a fact; a silent one offers that only once opened", async () => {
  const seeded = seededRun();
  const silentText = "I would have expected the board to minute it.";
  const run = {
    ...seeded,
    claims: seeded.claims.map((claim, index) =>
      index === 1
        ? {
            ...claim,
            verdict: noCover,
            refs: [],
            text: silentText,
            qualifiers: [
              {
                kind: "record-silent",
                explanation: "The witness's own expectation.",
                review: "routine",
              },
            ],
          }
        : claim,
    ),
  } satisfies VerificationRun;
  await mount(run);
  selectClaim(4);
  expect(screen.getByText(messages.avt.disposition.nocover)).toBeTruthy();
  expect(screen.queryByText(/Sign-off is optional/u)).toBeNull();
  expect(
    screen.getByRole("button", { name: messages.avt.gap.addFact }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: messages.avt.gap.linkFact }),
  ).toBeTruthy();
  // Needs evidence is one of the three next steps, offered once.
  expect(
    screen.getAllByRole("button", {
      name: messages.avt.review.status.needsEvidence,
    }),
  ).toHaveLength(1);
  // The decision pair waits behind one quiet menu, so nothing out-weighs it.
  expect(
    screen.queryByRole("button", {
      name: messages.avt.claimDetail.flagDispute,
    }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: messages.common.actions }),
  );
  expect(
    await screen.findByRole("menuitem", {
      name: messages.avt.claimDetail.flagDispute,
    }),
  ).toBeTruthy();
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
  });

  selectClaim(2);
  expect(
    screen
      .getAllByText(silentText)
      .some((node) => node.tagName === "BLOCKQUOTE"),
  ).toBe(true);
  expect(
    screen.queryByRole("button", { name: messages.avt.gap.addFact }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: messages.avt.gap.showNextSteps }),
  );
  expect(
    screen.getByRole("button", { name: messages.avt.gap.addFact }),
  ).toBeTruthy();
  expect(requests).toEqual([]);
});

/**
 * Answers this flow's requests and records them. The signed-in view also
 * reads per viewer (each claim's comments, the organization's settings);
 * those are answered as empty and not recorded.
 */
const answerSignedIn = (answered: ReadonlyMap<string, () => Response>) => {
  const seen: RecordedRequest[] = [];
  const product = fetchBoundary.getMockImplementation();
  fetchBoundary.mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const { pathname } = new URL(request.url);
        if (pathname.endsWith("/claim-comments")) {
          return Response.json({ items: [], limit: 100, nextCursor: null });
        }
        if (pathname === "/v1/organization-settings") {
          return Response.json({
            declaredFeatureIds: [],
            deploymentFeatures: { legalLists: false },
            capabilities: {},
          });
        }
        const answer = answered.get(`${request.method} ${pathname}`);
        if (answer === undefined) {
          return await (product ?? panic("No fetch boundary"))(input, init);
        }
        const text = await request.text();
        seen.push({
          method: request.method,
          path: pathname,
          body: text === "" ? null : JSON.parse(text),
        });
        return answer();
      },
      { preconnect: () => undefined },
    ),
  );
  return seen;
};

test("a list whose facts cannot be read says so with a retry, never that it has none", async () => {
  const seeded = seededRun();
  const notice = listFact(8, "The lender's notice letter is dated 3 June.");
  let reads = 0;
  answerSignedIn(
    new Map([
      [
        `GET /v1/lists/${workspaceId}/${seeded.evidence.listId}/items`,
        () => {
          reads += 1;
          return reads === 1
            ? Response.json({ error: "unavailable" }, { status: 500 })
            : Response.json({ items: [notice], nextCursor: null, limit: 100 });
        },
      ],
    ]),
  );
  await mount(seeded, true);
  selectClaim(4);
  fireEvent.click(
    screen.getByRole("button", { name: messages.avt.gap.linkFact }),
  );
  expect(await screen.findByText(messages.common.loadFailed)).toBeTruthy();
  expect(screen.queryByText(messages.avt.gap.noFacts)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: messages.common.retry }));
  expect(await screen.findByText(notice.name)).toBeTruthy();
});

test("linking a fact records the link as a review event, then re-checks the claim", async () => {
  const seeded = seededRun();
  const claim =
    seeded.claims.at(3) ?? panic("Missing seeded no-coverage claim");
  const notice = listFact(8, "The lender's notice letter is dated 3 June.");
  const held = {
    ...listFact(9, "A held note about the notice."),
    factDetails: {
      occurredOn: null,
      occurredOnPrecision: null,
      evidenceKind: null,
      medium: null,
      confidence: null,
      interpretationNote: null,
      scoring: "held",
    },
  } satisfies ListItem;
  const lists = `/v1/lists/${workspaceId}`;
  const answered = new Map<string, () => Response>([
    [
      `GET ${lists}/${seeded.evidence.listId}/items`,
      () =>
        Response.json({ items: [notice, held], nextCursor: null, limit: 100 }),
    ],
    [
      `POST ${lists}/claim-reviews`,
      () =>
        Response.json({
          claimId: claim.id,
          review: {
            ...EMPTY_CLAIM_REVIEW,
            linkedFactIds: [notice.id],
            eventCount: 1,
          },
        }),
    ],
    [
      `POST ${lists}/claim-rechecks`,
      () => Response.json({ replayed: false, claim }),
    ],
  ]);
  const seen = answerSignedIn(answered);
  const { run } = await mount(seeded, true);
  selectClaim(4);
  fireEvent.click(
    screen.getByRole("button", { name: messages.avt.gap.linkFact }),
  );
  const option = await screen.findByText(notice.name);
  // A held fact is never read by a check, so it cannot be linked.
  expect(screen.queryByText(held.name)).toBeNull();
  fireEvent.click(option);
  await waitFor(() => expect(seen).toHaveLength(3));
  expect(seen.map(({ method, path }) => `${method} ${path}`)).toEqual([
    `GET ${lists}/${run.evidence.listId}/items`,
    `POST ${lists}/claim-reviews`,
    `POST ${lists}/claim-rechecks`,
  ]);
  expect(seen.at(1)?.body).toEqual({
    runId: run.id,
    claimId: claim.id,
    event: { kind: "fact-link", factEntityId: notice.id, change: "link" },
  });
  expect(seen.at(2)?.body).toMatchObject({
    runId: run.id,
    claimId: claim.id,
    requestKey: expect.any(String),
  });
});

test("adding a fact from a document starts from the claim's words and asks for the document", async () => {
  const { run } = await mount();
  selectClaim(4);
  const claim = run.claims.at(3) ?? panic("Missing seeded no-coverage claim");
  fireEvent.click(
    screen.getByRole("button", { name: messages.avt.gap.addFact }),
  );
  const sheet = await screen.findByRole("dialog", {
    name: messages.avt.gap.sheet.title,
  });
  const statement = within(sheet).getByLabelText(messages.common.fact);
  expect(statement).toHaveProperty("value", claim.text);
  fireEvent.click(
    within(sheet).getByRole("button", { name: messages.avt.gap.sheet.submit }),
  );
  expect(
    await within(sheet).findByText(messages.lists.sources.documentRequired),
  ).toBeTruthy();
  expect(requests).toEqual([]);
});

test("an addition that failed midway finishes as first submitted, its fields held", async () => {
  const seeded = seededRun();
  const documentId = "0199a3c4-5b6d-7e8f-9a0b-000000009201";
  const versionId = "0199a3c4-5b6d-7e8f-9a0b-000000009202";
  const addedFactId = "0199a3c4-5b6d-7e8f-9a0b-000000009203";
  const lists = `/v1/lists/${workspaceId}`;
  let sourceWrites = 0;
  const seen = answerSignedIn(
    new Map([
      [
        `GET /v1/entities/${workspaceId}/entity/${documentId}`,
        () =>
          Response.json({ entityId: documentId, currentVersionId: versionId }),
      ],
      [
        `PUT /v1/tasks/${workspaceId}`,
        () => Response.json({ entityId: addedFactId }),
      ],
      [
        `POST ${lists}/item-sources`,
        () => {
          sourceWrites += 1;
          return sourceWrites === 1
            ? Response.json({ error: "unavailable" }, { status: 503 })
            : Response.json({ id: "0199a3c4-5b6d-7e8f-9a0b-000000009204" });
        },
      ],
      [
        `POST ${lists}/claim-reviews`,
        () =>
          Response.json({
            claimId: seeded.claims.at(3)?.id,
            review: { ...EMPTY_CLAIM_REVIEW, linkedFactIds: [addedFactId] },
          }),
      ],
      [
        `POST ${lists}/claim-rechecks`,
        () => Response.json({ replayed: false, claim: seeded.claims.at(3) }),
      ],
    ]),
  );
  const { client } = await mount(seeded, true);
  client.setQueryData(workspaceFilesOptions(workspaceId).queryKey, [
    {
      entityId: documentId,
      fieldId: "0199a3c4-5b6d-7e8f-9a0b-000000009205",
      name: "Lender's notice",
      fileName: "notice.docx",
      parentId: null,
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 12_000,
    },
  ]);
  selectClaim(4);
  fireEvent.click(
    screen.getByRole("button", { name: messages.avt.gap.addFact }),
  );
  const sheet = await screen.findByRole("dialog", {
    name: messages.avt.gap.sheet.title,
  });
  const picker = within(sheet).getByRole("combobox", {
    name: messages.common.document,
  });
  await act(async () => {
    picker.focus();
    fireEvent.input(picker, {
      target: { value: "notice" },
      inputType: "insertText",
    });
  });
  fireEvent.click(
    await screen.findByRole("option", { name: "Lender's notice" }),
  );
  const save = within(sheet).getByRole("button", {
    name: messages.avt.gap.sheet.submit,
  });
  fireEvent.click(save);
  await waitFor(() => expect(sourceWrites).toBe(1));
  await waitFor(() =>
    expect(within(sheet).getByLabelText(messages.common.fact)).toHaveProperty(
      "disabled",
      true,
    ),
  );
  // Leaving for another claim and coming back keeps the started fact.
  fireEvent.click(
    within(sheet).getByRole("button", { name: messages.common.cancel }),
  );
  selectClaim(2);
  selectClaim(4);
  fireEvent.click(
    screen.getByRole("button", { name: messages.avt.gap.addFact }),
  );
  const reopened = await screen.findByRole("dialog", {
    name: messages.avt.gap.sheet.title,
  });
  // What it was submitted with is held for the retry.
  const statement = within(reopened).getByLabelText(messages.common.fact);
  expect(statement).toHaveProperty("disabled", true);
  expect(statement).toHaveProperty(
    "value",
    seeded.claims.at(3)?.text ?? panic("Missing seeded claim"),
  );
  expect(
    within(reopened).getByRole("combobox", { name: messages.common.document }),
  ).toHaveProperty("disabled", true);
  fireEvent.click(
    within(reopened).getByRole("button", {
      name: messages.avt.gap.sheet.submit,
    }),
  );
  await waitFor(() =>
    expect(seen.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `PUT /v1/tasks/${workspaceId}`,
      `GET /v1/entities/${workspaceId}/entity/${documentId}`,
      `POST ${lists}/item-sources`,
      `GET /v1/entities/${workspaceId}/entity/${documentId}`,
      `POST ${lists}/item-sources`,
      `POST ${lists}/claim-reviews`,
      `POST ${lists}/claim-rechecks`,
    ]),
  );
  // The fact was added once, and sourced from the document first chosen.
  expect(seen.at(4)?.body).toMatchObject({
    itemEntityId: addedFactId,
    sourceEntityId: documentId,
    sourceEntityVersionId: versionId,
  });
});

test("a re-checked claim reads its new verdict beside the run's, and names a fact the run never pinned", async () => {
  const seeded = seededRun();
  const later = makeFact(7, {
    text: "The lender's notice letter is dated 3 June 2021.",
  });
  const run = {
    ...seeded,
    factStandings: [
      ...seeded.factStandings,
      {
        factEntityId: later.factEntityId,
        scoring: "included",
        tier: "unsourced",
      },
    ],
    claims: seeded.claims.map((claim, index) =>
      index === 3
        ? {
            ...claim,
            verdict: supported(86),
            refs: [{ factEntityId: later.factEntityId, rel: "supports" }],
            review: {
              ...EMPTY_CLAIM_REVIEW,
              linkedFactIds: [later.factEntityId],
              eventCount: 2,
            },
            recheck: {
              checkedAt: "2026-11-11T10:00:00.000Z",
              checkedBy: actorId,
              modelRef: null,
              factCount: 5,
              facts: [later],
              original: { verdict: noCover, refs: [], qualifiers: [] },
            },
          }
        : claim,
    ),
  } satisfies VerificationRun;
  await mount(run);
  selectClaim(4);
  const summary =
    screen.getByText(/^Re-checked .* against 5 facts\.$/u).parentElement ??
    panic("No re-check summary");
  expect(
    within(summary)
      .getAllByText(/^(No coverage|Supported)$/u)
      .map((badge) => badge.textContent),
  ).toEqual([
    messages.avt.states.nocover.chip,
    messages.avt.states.supported.chip,
  ]);
  // The linked fact the verdict cites shows once, on its card, marked as
  // linked and unlinkable there; the linked list keeps only its re-check.
  expect(screen.getAllByText(later.text)).toHaveLength(1);
  expect(screen.getByText(messages.avt.gap.linkedMark)).toBeTruthy();
  expect(
    screen.getByRole("button", {
      name: messages.avt.gap.unlink.replace("{fact}", () => later.text),
    }),
  ).toBeTruthy();
  expect(screen.getByText(messages.avt.gap.linked)).toBeTruthy();
  expect(
    screen.getByRole("button", { name: messages.avt.gap.recheck }),
  ).toBeTruthy();
  expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  // The verdict moved off the gap, so its next steps are gone.
  expect(
    screen.queryByRole("button", { name: messages.avt.gap.addFact }),
  ).toBeNull();
  expect(requests).toEqual([]);
});
