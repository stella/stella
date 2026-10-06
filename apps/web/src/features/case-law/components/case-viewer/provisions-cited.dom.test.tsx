import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { toSafeId } from "@/lib/safe-id";

import { provision } from "./provisions-cited.fixture";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });
const { act, cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { TooltipProvider } = await import("@stll/ui/tooltip");
const { ProvisionsCited } = await import("./provisions-cited");
const { decisionProvisionsInfiniteOptions, statutesResolveOptions } =
  await import("@/features/case-law/queries/provisions");
const messages = (await import("@/i18n/langs/en.json")).default;
const decisionId = toSafeId<"caseLawDecision">(
  "00000000-0000-4000-8000-000000000002",
);
const clients: InstanceType<typeof QueryClient>[] = [];

afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
});
afterAll(async () => {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
  await GlobalRegistrator.unregister();
});

type ProvisionsPage = Awaited<
  ReturnType<
    NonNullable<ReturnType<typeof decisionProvisionsInfiniteOptions>["queryFn"]>
  >
>;
type ResolvedWorks = Awaited<
  ReturnType<NonNullable<ReturnType<typeof statutesResolveOptions>["queryFn"]>>
>;
const workEli = "/eli/cz/sb/1964/40";
const title = "40/1964 Sb., Občanský zákoník";
const civilProvision = (overrides: Parameters<typeof provision>[0]) =>
  provision({
    anchor: "s1",
    section: 1,
    sectionSuffix: null,
    subsection: null,
    workEli: null,
    workIdentifier: "40/1964",
    workNumber: 40,
    workYear: 1964,
    sentenceText: "The decision applies section 1 of the Civil Code.",
    ...overrides,
  });
const mount = (items: ReturnType<typeof provision>[], resolveTitle = false) => {
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  clients.push(client);
  const page = {
    items,
    limit: 50,
    nextCursor: null,
    previews: [],
    status: { type: "legacy" },
    generation: "0",
    publishedProjectionDigest: null,
  } satisfies ProvisionsPage;
  client.setQueryData(decisionProvisionsInfiniteOptions(decisionId).queryKey, {
    pageParams: [null],
    pages: [page],
  });
  if (resolveTitle) {
    const work = { asOf: "2024-01-01", country: "CZE", eli: workEli };
    const resolved = [
      {
        ...work,
        unresolvedReason: null,
        statute: {
          country: "CZE",
          eli: workEli,
          id: toSafeId<"legislationDocument">(
            "00000000-0000-4000-8000-000000000003",
          ),
          language: "cs",
          slug: "40-1964-sb",
          title,
          versionValidFrom: "1964-01-01",
          versionValidTo: null,
          expressionKind: "consolidation",
          windowDisposition: "effective",
        },
      },
    ] satisfies ResolvedWorks;
    client.setQueryData(statutesResolveOptions([work]).queryKey, resolved);
  }
  const ui = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <TooltipProvider>
            <ProvisionsCited
              decisionDate="2024-01-01"
              decisionId={decisionId}
              expanded
              isHydrated
            />
          </TooltipProvider>
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  return { ...ui, client };
};

test("an inferred act shows its basis once and preserves repeated citation counts", () => {
  const { container } = mount(
    [
      civilProvision({ workEli }),
      civilProvision({ workEli, spanStart: 100, spanEnd: 160 }),
      civilProvision({
        workEli,
        anchor: "s2",
        section: 2,
        spanStart: 200,
        spanEnd: 260,
      }),
    ],
    true,
  );
  expect(screen.getAllByText(title)).toHaveLength(1);
  expect(screen.getAllByText("Decision date · inferred")).toHaveLength(1);
  expect(
    container.querySelectorAll('[data-version-basis="group"]'),
  ).toHaveLength(1);
  expect(
    container.querySelectorAll('[data-version-basis="exception"]'),
  ).toHaveLength(0);
  expect(screen.getByText("2×")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: title }).getAttribute("aria-expanded"),
  ).toBe("true");
});

test("a stated date marks only the exceptional provision in an inferred act", () => {
  const { container } = mount([
    civilProvision({}),
    civilProvision({ anchor: "s2", section: 2, spanStart: 100 }),
    civilProvision({
      anchor: "s3",
      section: 3,
      spanStart: 200,
      versionBasis: {
        type: "stated_date",
        date: "2001-01-01",
        relation: "on",
        expression: null,
        evidence: { kind: "stated_date", start: 0, end: 42 },
      },
    }),
  ]);
  expect(screen.getAllByText("Decision date · inferred")).toHaveLength(1);
  expect(
    container.querySelectorAll('[data-version-basis="exception"]'),
  ).toHaveLength(1);
  expect(screen.getByRole("button", { name: /§ 3/u }).textContent).toContain(
    "Stated: Jan 1, 2001",
  );
  expect(
    screen.getByRole("button", { name: /§ 1/u }).textContent,
  ).not.toContain("inferred");
  expect(
    screen.getByRole("button", { name: /§ 2/u }).textContent,
  ).not.toContain("inferred");
});

test("an act with one stated version shows the date only in its header", () => {
  const versionBasis = {
    type: "stated_date",
    date: "2001-01-01",
    relation: "on",
    expression: null,
    evidence: { kind: "stated_date", start: 0, end: 42 },
  } as const satisfies ReturnType<typeof provision>["versionBasis"];
  const { container } = mount([
    civilProvision({ versionBasis }),
    civilProvision({ anchor: "s2", section: 2, spanStart: 100, versionBasis }),
  ]);
  expect(screen.getAllByText("Stated: Jan 1, 2001")).toHaveLength(1);
  expect(
    container.querySelector('[data-version-basis="group"]')?.textContent,
  ).toBe("Stated: Jan 1, 2001");
  expect(
    container.querySelectorAll('[data-version-basis="exception"]'),
  ).toHaveLength(0);
  expect(screen.getByRole("button", { name: "§ 1" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "§ 2" })).toBeTruthy();
});

test("an act exposes a native keyboard button that collapses and reopens its references", async () => {
  mount([civilProvision({})]);
  const trigger = screen.getByRole("button", { name: "40/1964 Sb." });
  trigger.focus();
  expect(trigger.getAttribute("type")).toBe("button");
  expect(trigger.ownerDocument.activeElement).toBe(trigger);
  // HappyDOM does not synthesize native button activation from a key event.
  fireEvent.click(trigger, { detail: 0 });
  await waitFor(() =>
    expect(trigger.getAttribute("aria-expanded")).toBe("false"),
  );
  expect(screen.queryByRole("button", { name: /§ 1/u })).toBeNull();
  fireEvent.click(trigger, { detail: 0 });
  await waitFor(() =>
    expect(trigger.getAttribute("aria-expanded")).toBe("true"),
  );
  expect(screen.getByRole("button", { name: /§ 1/u })).toBeTruthy();
});

test("a new work on the next page opens while a user-collapsed work stays closed", async () => {
  const { client } = mount([civilProvision({})]);
  const first = screen.getByRole("button", { name: "40/1964 Sb." });
  expect(first.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(first);
  await waitFor(() =>
    expect(first.getAttribute("aria-expanded")).toBe("false"),
  );

  await act(async () => {
    client.setQueryData(
      decisionProvisionsInfiniteOptions(decisionId).queryKey,
      (data) => {
        const page = data?.pages.at(0);
        if (data === undefined || page === undefined) {
          throw new Error("Expected the mounted provisions page");
        }
        return {
          pageParams: [null, "page-2"],
          pages: [
            { ...page, nextCursor: "page-2" },
            {
              ...page,
              items: [provision({ workEli: null })],
              nextCursor: null,
            },
          ],
        };
      },
    );
  });

  const second = await screen.findByRole("button", { name: "141/1961 Sb." });
  await waitFor(() =>
    expect(second.getAttribute("aria-expanded")).toBe("true"),
  );
  expect(first.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByRole("button", { name: /§ 265b/u })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "§ 1" })).toBeNull();

  fireEvent.click(first);
  await waitFor(() => expect(first.getAttribute("aria-expanded")).toBe("true"));
  expect(second.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: "§ 1" })).toBeTruthy();
});

test("a focused provision reveals its full version basis and decision passage", async () => {
  mount([civilProvision({})]);
  const chip = screen.getByRole("button", { name: /§ 1/u });
  chip.focus();
  await waitFor(() => {
    expect(
      screen.getByText(messages.caseLaw.viewer.versionAtDecisionDateInferred),
    ).toBeTruthy();
    expect(
      screen.getByText(messages.caseLaw.viewer.citedDecisionPassage),
    ).toBeTruthy();
    expect(
      screen.getByText("The decision applies section 1 of the Civil Code."),
    ).toBeTruthy();
  });
});
