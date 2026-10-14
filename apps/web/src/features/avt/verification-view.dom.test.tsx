import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

import type { ClaimState, VerificationRun } from "./types";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
Object.assign(import.meta.env, { VITE_API_URL: "http://localhost:3001" });
type RecordedRequest = { method: string; path: string; body: unknown };
// Background auth reads are answered and ignored; every other request must be
// one a test seeded a response for, so assertions see only product traffic.
const requests: RecordedRequest[] = [];
const unexpectedRequests: string[] = [];
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
      return await answer;
    },
    { preconnect: () => undefined },
  ),
);
const { cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react");
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
const { verificationRunOptions } = await import("./queries");
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
} = await import("./avt.test-fixtures");
const messages = (await import("@/i18n/langs/en.json")).default;
const workspaceId = "0199a3c4-5b6d-7e8f-9a0b-000000009099";
const actorId = "0199a3c4-5b6d-7e8f-9a0b-000000009098";
const at = "2026-09-01T10:00:00Z";
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

const mount = async () => {
  const run = seededRun();
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
  render(
    <IntlProvider locale="en" messages={messages}>
      <FormattingProvider locale="en" timeZone="UTC">
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>
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

test("all verdicts expose their evidence and score explanations in the real detail panel", async () => {
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
    if (claim.verdict.score !== null) {
      expect(screen.getByText(String(claim.verdict.score))).toBeTruthy();
    }
    if (suffix === 1) {
      expect(
        screen.getByText("The signed agreement provides for July drawdown."),
      ).toBeTruthy();
    }
    if (suffix === 4) {
      expect(screen.getByText("The record is silent.")).toBeTruthy();
    }
    if (suffix === 6) {
      expect(screen.getByText("Not a verifiable assertion.")).toBeTruthy();
    }
    if (suffix === 5) {
      expect(
        screen.getByText(messages.avt.claimDetail.score.verdictWithheld),
      ).toBeTruthy();
      expect(screen.getByText("5 July 2021")).toBeTruthy();
      expect(screen.getByText("28 July 2021")).toBeTruthy();
    }
  }
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
      },
    },
  });
  expect(claimButton(5).textContent).toContain("Supported");
  expect(screen.getByText("0/2")).toBeTruthy();
  expect(
    screen.getByText(messages.avt.claimDetail.score.verdictWithheld),
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
      event: { kind: "record-conflict", resolution: { kind: "escalated" } },
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
    screen.getByText(messages.avt.claimDetail.score.verdictWithheld),
  ).toBeTruthy();
  expect(screen.getByText("5 July 2021")).toBeTruthy();
  expect(screen.getByText("28 July 2021")).toBeTruthy();
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
