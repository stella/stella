import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

import type { FactDetails, ListItem } from "./types";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
Object.assign(import.meta.env, { VITE_API_URL: "http://localhost:3001" });
const { act, cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { AnchorFactsPanel } = await import("./anchor-facts-panel");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { legalListItemsOptions } =
  await import("@/lib/workspaces/queries/legal-lists");
const { roleOptions } = await import("@/lib/auth-queries");
const { toSafeId } = await import("@/lib/safe-id");
const messages = (await import("@/i18n/langs/en.json")).default;

const workspaceId = "019a0000-0000-7000-8000-000000000001";
const listId = "019a0000-0000-7000-8000-000000000002";
const user = {
  id: "reviewer",
  activeOrganizationId: "organization",
  email: "reviewer@example.test",
  image: null,
  name: "Reviewer",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};
const fact = {
  id: toSafeId<"entity">("019a0000-0000-7000-8000-000000000003"),
  name: "The payment date is disputed",
  itemType: "fact",
  status: "open",
  priority: "none",
  dueDate: null,
  sectionId: null,
  position: "a0",
  description: null,
  reviewStatus: "unreviewed",
  createdAt: "2026-10-01T12:00:00Z",
  updatedAt: "2026-10-01T12:00:00Z",
  customFields: [],
  firstSource: null,
  factDetails: null,
} as const satisfies ListItem;
const clients: InstanceType<typeof QueryClient>[] = [];
const spies: { mockRestore: () => void }[] = [];

afterEach(async () => {
  await act(async () => {
    await waitFor(() => {
      expect(
        clients.every(
          (client) => client.isMutating() === 0 && client.isFetching() === 0,
        ),
      ).toBe(true);
    });
    cleanup();
  });
  for (const client of clients.splice(0)) {
    client.clear();
  }
  for (const spy of spies.splice(0)) {
    spy.mockRestore();
  }
});
afterAll(async () => await unregisterDomEnvironment());

type MountFactOptions = {
  name?: string;
  statement?: string;
  factDetails?: ListItem["factDetails"];
  role?: "owner" | "intern";
};

const mountFact = ({
  name = fact.name,
  statement = name,
  factDetails = null,
  role = "owner",
}: MountFactOptions = {}) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { enabled: false, retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  client.setQueryData(roleOptions.queryKey, role);
  const itemsKey = legalListItemsOptions({
    workspaceId,
    listId,
    viewer: { userId: user.id, organizationId: user.activeOrganizationId },
  }).queryKey;
  client.setQueryData(itemsKey, {
    pages: [
      { items: [{ ...fact, name, factDetails }], nextCursor: null, limit: 100 },
    ],
    pageParams: [null],
  });
  const requests: { method: string; pathname: string; body: unknown }[] = [];
  const boundary = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const pathname = new URL(request.url).pathname;
        if (
          request.method === "PUT" &&
          pathname === `/v1/lists/${workspaceId}/item-fact-details`
        ) {
          const body: unknown = await request.json();
          requests.push({ method: request.method, pathname, body });
          if (typeof body !== "object" || body === null) {
            throw new TypeError("Fact detail PUT must contain an object");
          }
          return Response.json({
            ...Object.fromEntries(
              Object.entries(body).filter(
                ([key]) => key !== "listId" && key !== "occurredOn",
              ),
            ),
            occurredOn: null,
            occurredOnPrecision: null,
          });
        }
        if (
          request.method === "GET" &&
          pathname === "/v1/organization-settings"
        ) {
          return Response.json({
            declaredFeatureIds: [],
            deploymentFeatures: { legalLists: false },
            capabilities: {},
          });
        }
        throw new TypeError(
          `Unexpected request: ${request.method} ${pathname}`,
        );
      },
      { preconnect: () => undefined },
    ),
  );
  spies.push(boundary);
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <AuthenticatedUserProvider user={user}>
          <QueryClientProvider client={client}>
            <AnchorFactsPanel workspaceId={workspaceId} listId={listId} />
          </QueryClientProvider>
        </AuthenticatedUserProvider>
      </FormattingProvider>
    </IntlProvider>,
  );
  expect(
    client.getQueryData(itemsKey)?.pages.at(0)?.items.at(0)?.factDetails,
  ).toEqual(factDetails);
  expect(screen.getByText(statement)).toBeTruthy();
  return requests;
};

/** Opens the fact row's actions menu and returns the named item. */
const factAction = async (name: string) => {
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: messages.common.actions }),
    );
  });
  return await screen.findByRole("menuitem", { name });
};

const mountUndescribedFact = async () => {
  const requests = mountFact();
  expect(screen.getByText(messages.avt.anchorFacts.inScoring)).toBeTruthy();
  const hold = await factAction(messages.avt.anchorFacts.holdOutOfScoring);
  expect(hold.getAttribute("aria-disabled")).not.toBe("true");
  expect(
    screen
      .getByRole("menuitem", {
        name: messages.avt.anchorFacts.addInterpretationNote,
      })
      .getAttribute("aria-disabled"),
  ).not.toBe("true");
  return requests;
};

test("a new fact can be held out of scoring without assigning confidence", async () => {
  const requests = await mountUndescribedFact();
  await act(async () => {
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: messages.avt.anchorFacts.holdOutOfScoring,
      }),
    );
  });
  await waitFor(() => {
    expect(requests).toEqual([
      {
        method: "PUT",
        pathname: `/v1/lists/${workspaceId}/item-fact-details`,
        body: {
          listId,
          itemEntityId: fact.id,
          occurredOn: null,
          evidenceKind: null,
          medium: null,
          confidence: null,
          interpretationNote: null,
          scoring: "held",
        },
      },
    ]);
  });
});

test("a new fact can receive an interpretation note without assigning confidence", async () => {
  const requests = await mountUndescribedFact();
  await act(async () => {
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: messages.avt.anchorFacts.addInterpretationNote,
      }),
    );
  });
  fireEvent.change(
    screen.getByRole("textbox", {
      name: messages.avt.anchorFacts.interpretationNote,
    }),
    {
      target: { value: "  The date needs reconciliation.  " },
    },
  );
  fireEvent.click(screen.getByRole("button", { name: messages.common.save }));
  await waitFor(() => {
    expect(requests).toEqual([
      {
        method: "PUT",
        pathname: `/v1/lists/${workspaceId}/item-fact-details`,
        body: {
          listId,
          itemEntityId: fact.id,
          occurredOn: null,
          evidenceKind: null,
          medium: null,
          confidence: null,
          interpretationNote: "The date needs reconciliation.",
          scoring: "included",
        },
      },
    ]);
  });
});

const describedFact = {
  occurredOn: null,
  occurredOnPrecision: null,
  evidenceKind: null,
  medium: null,
  confidence: "high",
  interpretationNote: null,
} as const satisfies FactDetails;

for (const scenario of [
  {
    role: "intern",
    factDetails: null,
    reason: messages.errors.api.forbidden,
    status: messages.avt.anchorFacts.inScoring,
    name: "a reviewer without update permission cannot edit a new fact",
  },
  {
    role: "owner",
    factDetails: describedFact,
    reason: messages.errors.actionAdmission.notEnabled,
    status: null,
    name: "a fact with scoring omitted cannot be edited even by an owner",
  },
] as const) {
  test(scenario.name, async () => {
    const requests = mountFact(scenario);
    for (const label of [
      messages.avt.anchorFacts.inScoring,
      messages.avt.anchorFacts.heldForReview,
    ]) {
      expect(screen.queryByText(label) !== null).toBe(
        label === scenario.status,
      );
    }
    const hold = await factAction(messages.avt.anchorFacts.holdOutOfScoring);
    const note = screen.getByRole("menuitem", {
      name: messages.avt.anchorFacts.addInterpretationNote,
    });
    expect(hold.getAttribute("aria-disabled")).toBe("true");
    expect(note.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen
        .getByRole("combobox", {
          name: messages.avt.anchorFacts.interpretiveConfidence,
        })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByText(scenario.reason)).toBeTruthy();
    fireEvent.click(hold);
    fireEvent.click(note);
    expect(
      screen.queryByRole("textbox", {
        name: messages.avt.anchorFacts.interpretationNote,
      }),
    ).toBeNull();
    expect(requests).toEqual([]);
  });
}

test("Not stated clears an existing confidence while preserving scoring", async () => {
  const requests = mountFact({
    factDetails: { ...describedFact, scoring: "included" },
  });
  await act(async () => {
    fireEvent.mouseDown(
      screen.getByRole("combobox", {
        name: messages.avt.anchorFacts.interpretiveConfidence,
      }),
      { button: 0 },
    );
  });
  const notStated = await screen.findByRole("option", {
    name: messages.common.notStated,
  });
  await act(async () => {
    fireEvent.pointerDown(notStated, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(notStated, { button: 0, pointerType: "mouse" });
    fireEvent.click(notStated, { button: 0, detail: 1 });
  });
  await waitFor(() => {
    expect(requests).toEqual([
      {
        method: "PUT",
        pathname: `/v1/lists/${workspaceId}/item-fact-details`,
        body: {
          listId,
          itemEntityId: fact.id,
          occurredOn: null,
          evidenceKind: null,
          medium: null,
          confidence: null,
          interpretationNote: null,
          scoring: "included",
        },
      },
    ]);
  });
});

test("an imported fact reads as reference, statement and one meta line", () => {
  mountFact({
    name: "CAL-01: 9 Mar 2021 (Outlook export p.14): Calendar invitation shown as accepted.",
    statement: "Calendar invitation shown as accepted.",
    factDetails: {
      ...describedFact,
      occurredOn: "2021-03-09",
      occurredOnPrecision: "day",
      evidenceKind: "Calendar",
      medium: "Outlook export p.14",
    },
  });
  expect(screen.getByText("CAL-01")).toBeTruthy();
  expect(screen.getByText("Calendar")).toBeTruthy();
  expect(screen.getAllByText("Outlook export p.14")).toHaveLength(1);
  expect(screen.queryByText(/9 Mar 2021 \(/u)).toBeNull();
});

test("a held fact shows its status and is included in one click", async () => {
  const requests = mountFact({
    factDetails: { ...describedFact, scoring: "held" },
  });
  expect(
    screen.getAllByText(messages.avt.anchorFacts.heldForReview),
  ).not.toHaveLength(0);
  expect(screen.queryByText(messages.avt.anchorFacts.inScoring)).toBeNull();
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", {
        name: messages.avt.anchorFacts.includeInScoring,
      }),
    );
  });
  await waitFor(() => {
    expect(requests).toEqual([
      {
        method: "PUT",
        pathname: `/v1/lists/${workspaceId}/item-fact-details`,
        body: {
          listId,
          itemEntityId: fact.id,
          occurredOn: null,
          evidenceKind: null,
          medium: null,
          confidence: "high",
          interpretationNote: null,
          scoring: "included",
        },
      },
    ]);
  });
});
