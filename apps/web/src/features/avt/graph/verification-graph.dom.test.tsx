import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import type { VerificationGraphPage } from "@/features/avt/types";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
Object.assign(import.meta.env, { VITE_API_URL: "http://localhost:3001" });

const { act, cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react");
const {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} = await import("@tanstack/react-router");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { createTranslator } = await import("use-intl/core");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { setTranslator } = await import("@/i18n/translator");
const { roleOptions } = await import("@/lib/auth-queries");
const { VerificationGraph } = await import("./verification-graph");
const { Chronology } = await import("./chronology");
const { verificationGraphOptions, verificationRunOptions } =
  await import("@/features/avt/queries");
const { makeClaim, makeRun, noCover } =
  await import("@/features/avt/avt.test-fixtures");
const {
  GRAPH_TEXT,
  graphClaimId,
  graphFactId,
  graphPage,
  sourceId,
  statementId,
} = await import("./graph.test-fixtures");
const messages = (await import("@/i18n/langs/en.json")).default;

const workspaceId = "019b0000-0000-7000-8000-000000000001";
const clients: InstanceType<typeof QueryClient>[] = [];
let narrow = false;

/** The run a claim of the first statement opens in the panel. */
const firstStatementRun = () => {
  const claim = makeClaim({ suffix: 1, verdict: noCover });
  return {
    ...makeRun([{ ...claim, id: graphClaimId(2), text: GRAPH_TEXT.payment }]),
    id: statementId(1),
  };
};

const mount = async (
  view: "graph" | "chronology",
  page: VerificationGraphPage = graphPage(),
) => {
  setTranslator(createTranslator({ locale: "en", messages }));
  const client = new QueryClient({
    defaultOptions: {
      queries: { enabled: false, retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  client.setQueryData(roleOptions.queryKey, "owner");
  client.setQueryData(
    verificationGraphOptions({ workspaceId, listId: page.listId }).queryKey,
    {
      pages: [page],
      pageParams: [null],
    },
  );
  const run = firstStatementRun();
  client.setQueryData(
    verificationRunOptions(workspaceId, run.id).queryKey,
    run,
  );
  const reviews: string[] = [];
  const root = createRootRoute({ component: Outlet });
  const protectedRoute = createRoute({
    getParentRoute: () => root,
    id: "_protected",
    beforeLoad: () => ({ user: { id: "user-graph" } }),
    component: Outlet,
  });
  const home = createRoute({
    getParentRoute: () => protectedRoute,
    path: "/",
    component: () =>
      view === "graph" ? (
        <VerificationGraph
          listId={page.listId}
          onReview={() => reviews.push("review")}
          workspaceId={workspaceId}
        />
      ) : (
        <Chronology listId={page.listId} workspaceId={workspaceId} />
      ),
  });
  const router = createRouter({
    routeTree: root.addChildren([protectedRoute.addChildren([home])]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </FormattingProvider>
    </IntlProvider>,
  );
  return { reviews };
};

const canvas = () => screen.getByTestId("avt-graph-canvas");
const node = (key: string) =>
  canvas().querySelector<HTMLElement>(`[data-node="${key}"]`) ??
  panic(`No graph node ${key}`);
const nodeOrNull = (key: string) =>
  canvas().querySelector<HTMLElement>(`[data-node="${key}"]`);
const dimmed = (element: HTMLElement) => element.dataset["dimmed"] === "true";

beforeEach(() => {
  narrow = false;
  spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: narrow ? !query.includes("min-width") : true,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) satisfies MediaQueryList,
  );
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        return Response.json(
          { message: `Unexpected request ${request.method} ${request.url}` },
          { status: 500 },
        );
      },
      { preconnect: () => undefined },
    ),
  );
});

afterEach(() => {
  cleanup();
  mock.restore();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
});

afterAll(async () => {
  await act(async () => {
    await Promise.resolve();
  });
  await unregisterDomEnvironment();
});

test("focusing a fact keeps its claims and sources and dims the rest", async () => {
  await mount("graph");
  const fact = `fact:${graphFactId(2)}`;
  fireEvent.click(node(fact));
  expect(dimmed(node(fact))).toBe(false);
  expect(dimmed(node(`claim:${graphClaimId(2)}`))).toBe(false);
  expect(dimmed(node(`source:${sourceId(2)}`))).toBe(false);
  // One hop only: the claim's other record and the other claims fade.
  expect(dimmed(node(`fact:${graphFactId(3)}`))).toBe(true);
  expect(dimmed(node(`claim:${graphClaimId(1)}`))).toBe(true);
  const lit = canvas().querySelector(
    `[data-edge="${graphClaimId(2)}|${graphFactId(2)}"]`,
  );
  const faded = canvas().querySelector(
    `[data-edge="${graphClaimId(2)}|${graphFactId(3)}"]`,
  );
  expect(lit?.getAttribute("opacity")).toBe("0.9");
  expect(faded?.getAttribute("opacity")).toBe("0.12");
  // A second click on the focused node lets the whole graph back.
  fireEvent.click(node(fact));
  expect(dimmed(node(`claim:${graphClaimId(1)}`))).toBe(false);
});

test("a record conflict draws both records from its claim", async () => {
  await mount("graph");
  const edges = [...canvas().querySelectorAll<SVGPathElement>("[data-edge]")]
    .map((edge) => edge.dataset["edge"])
    .filter((key) => key?.startsWith(graphClaimId(2)) === true);
  expect(edges.toSorted()).toEqual(
    [
      `${graphClaimId(2)}|${graphFactId(2)}`,
      `${graphClaimId(2)}|${graphFactId(3)}`,
    ].toSorted(),
  );
});

test("clicking a claim opens the review's claim panel for it", async () => {
  await mount("graph");
  fireEvent.click(node(`claim:${graphClaimId(2)}`));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText(messages.avt.graph.claimTitle)).toBeTruthy();
  expect(
    within(dialog).getAllByText(GRAPH_TEXT.payment).length,
  ).toBeGreaterThan(0);
});

test("the filters narrow the claims and hide held facts", async () => {
  await mount("graph");
  fireEvent.click(
    screen.getByRole("combobox", { name: messages.avt.graph.filters.verdict }),
  );
  fireEvent.click(
    await screen.findByRole("option", {
      name: messages.avt.graph.filters.conflicts,
    }),
  );
  await waitFor(() => {
    expect(nodeOrNull(`claim:${graphClaimId(1)}`)).toBeNull();
  });
  expect(nodeOrNull(`claim:${graphClaimId(2)}`)).not.toBeNull();
  expect(nodeOrNull(`claim:${graphClaimId(4)}`)).not.toBeNull();
  // The supporting fact only the supported claim linked goes with it.
  expect(nodeOrNull(`fact:${graphFactId(1)}`)).toBeNull();

  fireEvent.click(
    screen.getByRole("switch", { name: messages.avt.graph.filters.heldFacts }),
  );
  await waitFor(() => {
    expect(nodeOrNull(`fact:${graphFactId(5)}`)).toBeNull();
  });
  expect(nodeOrNull(`claim:${graphClaimId(4)}`)).not.toBeNull();

  fireEvent.click(
    screen.getByRole("button", { name: messages.common.clearFilters }),
  );
  await waitFor(() => {
    expect(nodeOrNull(`claim:${graphClaimId(1)}`)).not.toBeNull();
  });
});

test("a narrow screen gets the list form of the same graph, not the canvas", async () => {
  narrow = true;
  await mount("graph");
  expect(screen.queryByTestId("avt-graph-canvas")).toBeNull();
  const list = screen.getByRole("region", {
    name: messages.avt.graph.listLabel,
  });
  expect(
    within(list).getByRole("heading", { name: /Witness statement\.docx/u }),
  ).toBeTruthy();
  const conflict = within(list)
    .getByRole("button", { name: new RegExp(GRAPH_TEXT.payment, "u") })
    .closest("li");
  const chips = within(conflict ?? panic("No claim row")).getAllByText(
    messages.avt.graph.relation.recordConflict,
  );
  expect(chips).toHaveLength(2);
  // Held and off-list facts say so in words, not by style alone.
  expect(
    within(list).getByText(new RegExp(GRAPH_TEXT.heldNote, "u")),
  ).toBeTruthy();
  expect(within(list).getAllByText(/Held/u).length).toBeGreaterThan(0);
});

test("the list form is also there for screen readers beside the canvas", async () => {
  await mount("graph");
  expect(
    screen.getByTestId("avt-graph-canvas").getAttribute("aria-hidden"),
  ).toBe("true");
  expect(
    screen.getByRole("region", { name: messages.avt.graph.listLabel }),
  ).toBeTruthy();
});

test("the chronology dates each fact only as precisely as it is known", async () => {
  await mount("chronology");
  const chronology = screen.getByTestId("avt-chronology");
  const rows = within(chronology)
    .getAllByRole("listitem")
    .filter((item) => item.parentElement?.tagName === "OL");
  const texts = rows.map((row) => row.textContent);
  const at = (text: string) =>
    texts.findIndex((content) => content.includes(text));
  // Year, then month, then days; the undated last.
  expect(at(GRAPH_TEXT.calendar)).toBeLessThan(at(GRAPH_TEXT.minutes));
  expect(at(GRAPH_TEXT.minutes)).toBeLessThan(at(GRAPH_TEXT.ledger));
  expect(at(GRAPH_TEXT.ledger)).toBeLessThan(at(GRAPH_TEXT.recalled));
  expect(at(GRAPH_TEXT.recalled)).toBeLessThan(at(GRAPH_TEXT.undatedFact));
  const monthRow = rows[at(GRAPH_TEXT.minutes)];
  const yearRow = rows[at(GRAPH_TEXT.calendar)];
  // A month is never shown as its stored first day, a year never as 1 Jan.
  expect(monthRow?.textContent).toContain("March 2021");
  expect(monthRow?.textContent).not.toMatch(/\b1\b/u);
  expect(yearRow?.firstElementChild?.textContent).toBe("2021");
  expect(
    within(chronology).getByRole("heading", {
      name: messages.avt.chronology.undated,
    }),
  ).toBeTruthy();
});

test("a chronology row's claim chip opens that claim", async () => {
  await mount("chronology");
  const chronology = screen.getByTestId("avt-chronology");
  fireEvent.click(
    within(chronology).getAllByRole("button", {
      name: new RegExp(GRAPH_TEXT.payment, "u"),
    })[0] ?? panic("No claim chip"),
  );
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getAllByText(GRAPH_TEXT.payment).length,
  ).toBeGreaterThan(0);
});
