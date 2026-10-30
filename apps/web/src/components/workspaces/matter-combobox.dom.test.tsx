import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import type { WebApiRoutes } from "@/lib/api";
import type { WorkspaceNavigationItem } from "@/lib/memory-api";
import { toSafeId } from "@/lib/safe-id";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/", width: 1280 });
// A hung test fails instead of holding the run. Assertions compare strings
// and booleans, never DOM nodes: a failing match on a node makes the runner
// print the whole document graph.

const testing = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { Profiler, useState } = await import("react");
const { panic } = await import("better-result");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { workspacesNavigationOptions } =
  await import("@/lib/workspaces/queries");
const { groupedChatThreadsOptions } = await import("@/features/chat/queries");
const { usePinnedStore } = await import("@/lib/pinned-store");
const { resolveMatterColor } = await import("@stll/ui/matter-colors");
const { RenderLoopGuard } = await import("@/testing/render-loop-guard");
const { MatterCombobox } = await import("./matter-combobox");

type MatterOption = Parameters<typeof MatterCombobox>[0]["value"];
type ThreadSlice =
  WebApiRoutes["chat"]["threads"]["get"]["response"][200]["global"][number];

/**
 * How many commits the picker may take to settle after mounting, and again
 * after one keystroke. A settled picker needs a handful; an option list
 * rebuilt on every render never settles.
 */
const MATTER_PICKER_SETTLE_COMMITS = 10;

const ORGANIZATION_ID = "00000000-0000-7000-8000-00000000ffff";
const USER_ID = "00000000-0000-7000-8000-00000000fffe";
const NOW = new Date("2026-10-11T12:00:00.000Z");
const LATEST_CHAT_ACTIVITY = new Date("2026-10-11T13:00:00.000Z");

const matter = (
  id: string,
  name: string,
  color: string | null,
  client: string | null,
  lastActivityAt = NOW,
) =>
  ({
    client:
      client === null
        ? null
        : { displayName: client, id: toSafeId<"contact">(id) },
    clientId: null,
    color,
    defaultViewId: null,
    id: toSafeId<"workspace">(id),
    lastActivityAt,
    name,
    reference: `M-${id.slice(-4)}`,
    status: "active",
  }) satisfies WorkspaceNavigationItem;

const NOVAK = matter(
  "00000000-0000-7000-8000-0000000000a1",
  "Novák v. Horák",
  "#b4442f",
  "Novák s.r.o.",
);
const LEASE = matter(
  "00000000-0000-7000-8000-0000000000b2",
  "Lease renewal Vinohrady",
  "#2f6db4",
  null,
);

// Seven matters, each a day less active than the one before.
const MANY = Array.from({ length: 7 }, (_, index) =>
  matter(
    `00000000-0000-7000-8000-00000000c0${index}0`,
    `Matter ${index}`,
    "#5a6b7c",
    null,
    new Date(NOW.getTime() - index * 86_400_000),
  ),
);
const many = (index: number) =>
  MANY.at(index) ?? panic(`No fixture matter ${index}`);

type ChatActivity = { workspaceId: string; updatedAt: string };

const clients: InstanceType<typeof QueryClient>[] = [];

afterEach(() => {
  usePinnedStore.setState({ pinnedIds: new Set(), pinnedOrder: [] });
  testing.cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const openCombobox = (
  initial: MatterOption = null,
  {
    chat = [],
    pinned = [],
    onCommit = () => {},
    workspaces = [NOVAK, LEASE],
  }: {
    chat?: ChatActivity[];
    /** Called on every commit of the picker's subtree. */
    onCommit?: () => void;
    pinned?: string[];
    workspaces?: WorkspaceNavigationItem[];
  } = {},
) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(client);
  client.setQueryData(
    workspacesNavigationOptions({
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
    }).queryKey,
    { workspaces, features: { timeBilling: false } },
  );
  const history = groupedChatThreadsOptions({
    activeOrganizationId: ORGANIZATION_ID,
    userId: USER_ID,
  });
  client.setQueryData(history.queryKey, {
    pageParams: [history.initialPageParam],
    pages: [
      {
        global: [],
        nextCursor: null,
        workspaces: chat.map(({ workspaceId, updatedAt }) => ({
          workspaceId,
          workspaceName: workspaceId,
          threads: [
            {
              context: { fileCount: 0, files: [], matterCount: 0, matters: [] },
              createdAt: updatedAt,
              decision: null,
              id: `thread-${workspaceId}`,
              origin: "original" as const,
              title: "Chat",
              updatedAt,
              usedAnonymization: false,
            } satisfies ThreadSlice,
          ],
        })),
      },
    ],
  });
  usePinnedStore.setState({ pinnedIds: new Set(pinned), pinnedOrder: pinned });
  const Host = () => {
    const [value, setValue] = useState(initial);
    return (
      <MatterCombobox
        activeOrganizationId={ORGANIZATION_ID}
        id="matter"
        onChange={setValue}
        userId={USER_ID}
        value={value}
      />
    );
  };
  const ui = testing.render(
    <RenderLoopGuard>
      <QueryClientProvider client={client}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <Profiler id="matter-combobox" onRender={onCommit}>
            <Host />
          </Profiler>
        </IntlProvider>
      </QueryClientProvider>
    </RenderLoopGuard>,
  );
  const input = ui.getByRole("combobox");
  if (!(input instanceof HTMLInputElement)) {
    throw new TypeError("Expected the matter combobox input");
  }
  return { input, ui };
};

const type = async (input: HTMLInputElement, value: string) => {
  await testing.act(async () => {
    input.focus();
    testing.fireEvent.input(input, {
      target: { value },
      inputType: "insertText",
    });
  });
};

/** The colour an element paints, as the DOM normalizes it. */
const paintedColor = (element: Element | null | undefined) =>
  element instanceof SVGElement ? element.style.color : "";

const expectedColor = (color: string) => {
  const probe = document.createElement("span");
  probe.style.color = color;
  expect(probe.style.color).not.toBe("");
  return probe.style.color;
};

const openList = async (input: HTMLInputElement) => {
  await testing.act(async () => {
    input.focus();
    testing.fireEvent.keyDown(input, { key: "ArrowDown" });
  });
};

// The popup's option groups. Not `role="group"`: the input's own wrapper
// carries that role too.
const optionGroups = () => [
  ...document.querySelectorAll<HTMLElement>('[data-slot="combobox-group"]'),
];

const groupedOptions = () =>
  optionGroups().map((group) => [
    document.querySelector(
      `[id="${group.getAttribute("aria-labelledby") ?? ""}"]`,
    )?.textContent ?? "",
    testing
      .within(group)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ]);

describe("matter combobox rendering", () => {
  test("settles within a few commits after mounting and after a keystroke", async () => {
    let commits = 0;
    const countCommit = () => {
      commits += 1;
      if (commits > MATTER_PICKER_SETTLE_COMMITS) {
        // Thrown from the commit phase, this unmounts the tree and ends a
        // render loop at once instead of letting it grow.
        panic(
          `MatterCombobox did not settle: more than ${MATTER_PICKER_SETTLE_COMMITS} commits`,
        );
      }
    };
    const { input } = openCombobox(null, {
      chat: [
        {
          workspaceId: many(6).id,
          updatedAt: LATEST_CHAT_ACTIVITY.toISOString(),
        },
      ],
      onCommit: countCommit,
      pinned: [many(5).id],
      workspaces: MANY,
    });
    await testing.act(async () => {});
    expect(commits).toBeLessThanOrEqual(MATTER_PICKER_SETTLE_COMMITS);

    commits = 0;
    await type(input, "M");
    expect(commits).toBeGreaterThan(0);
    expect(commits).toBeLessThanOrEqual(MATTER_PICKER_SETTLE_COMMITS);
  });
});

describe("matter combobox groups", () => {
  test("browsing has recent matters without pins or chat history", async () => {
    const { input } = openCombobox(null, { workspaces: MANY });
    await openList(input);

    await testing.waitFor(() =>
      expect(groupedOptions()).toEqual([
        [messages.navigation.recents, MANY.slice(0, 5).map(({ name }) => name)],
        [
          messages.inspector.matterPicker.allMatters,
          MANY.slice(5).map(({ name }) => name),
        ],
      ]),
    );
  });

  test("browsing leads with recent matters: pinned, then by activity, then all others", async () => {
    expect(LATEST_CHAT_ACTIVITY.getTime()).toBeGreaterThan(
      many(0).lastActivityAt.getTime(),
    );
    const { input } = openCombobox(null, {
      // A recent chat lifts the least active matter into the group.
      chat: [
        {
          workspaceId: many(6).id,
          updatedAt: LATEST_CHAT_ACTIVITY.toISOString(),
        },
      ],
      pinned: [many(5).id],
      workspaces: MANY,
    });
    await openList(input);

    await testing.waitFor(() =>
      expect(groupedOptions()).toEqual([
        [
          messages.navigation.recents,
          [
            many(5).name,
            many(6).name,
            many(0).name,
            many(1).name,
            many(2).name,
          ],
        ],
        [
          messages.inspector.matterPicker.allMatters,
          [many(3).name, many(4).name],
        ],
      ]),
    );
  });

  test("typing drops the groups for one filtered list", async () => {
    const { input, ui } = openCombobox(null, { workspaces: MANY });
    await type(input, "Matter 6");

    await testing.waitFor(() =>
      expect(
        ui.getAllByRole("option").map((option) => option.textContent),
      ).toEqual([many(6).name]),
    );
    expect(optionGroups().length).toBe(0);
    expect(ui.queryByText(messages.navigation.recents)).toBeNull();
  });

  test("the keyboard reaches the recent group first", async () => {
    const { input, ui } = openCombobox(null, {
      pinned: [many(4).id],
      workspaces: MANY,
    });
    await openList(input);
    await testing.waitFor(() =>
      expect(ui.getAllByRole("option").length).toBeGreaterThan(0),
    );
    if (
      ui.container.ownerDocument.querySelector("[data-highlighted]") === null
    ) {
      await testing.act(async () => {
        testing.fireEvent.keyDown(input, { key: "ArrowDown" });
      });
    }

    await testing.waitFor(() =>
      expect(
        ui.container.ownerDocument.querySelector("[data-highlighted]")
          ?.textContent,
      ).toBe(many(4).name),
    );
  });
});

describe("matter combobox", () => {
  test("the full list never shows the empty state", async () => {
    const { input, ui } = openCombobox();
    await openList(input);

    await testing.waitFor(() =>
      expect(ui.getAllByRole("option")).toHaveLength(2),
    );
    expect(ui.queryByText(messages.common.noResults)).toBeNull();
  });

  test("a search that matches nothing shows the empty state", async () => {
    const { input, ui } = openCombobox();
    await type(input, "arbitration");

    await testing.waitFor(() =>
      expect(ui.getByText(messages.common.noResults)).toBeDefined(),
    );
    expect(ui.queryAllByRole("option")).toHaveLength(0);
  });

  test("matches a client's name, ignoring accents and case", async () => {
    const { input, ui } = openCombobox();
    await type(input, "NOVAK S.R.O");

    await testing.waitFor(() =>
      expect(
        ui.getAllByRole("option").map((option) => option.textContent),
      ).toEqual([expect.stringContaining(NOVAK.name)]),
    );
  });

  test("every option draws its matter's coloured icon before the name", async () => {
    const { input, ui } = openCombobox();
    await openList(input);

    const options = await testing.waitFor(() => {
      const found = ui.getAllByRole("option");
      expect(found).toHaveLength(2);
      return found;
    });
    for (const [option, source] of [
      [options.at(0), NOVAK],
      [options.at(1), LEASE],
    ] as const) {
      const icon = option?.querySelector("svg.lucide-layers");
      expect(icon instanceof SVGElement).toBe(true);
      expect(paintedColor(icon)).toBe(
        expectedColor(resolveMatterColor(source.id, source.color)),
      );
      // Document order: the icon, then the name.
      expect(
        [...(option?.querySelectorAll("svg.lucide-layers, bdi") ?? [])].map(
          (element) => element.textContent,
        ),
      ).toEqual([
        "",
        source.name,
        ...(source.client === null ? [] : [source.client.displayName]),
      ]);
    }
  });

  test("a chosen matter shows its name and icon in the field", () => {
    const { input, ui } = openCombobox({
      clientName: null,
      color: LEASE.color,
      id: LEASE.id,
      name: LEASE.name,
    });

    expect(input.value).toBe(LEASE.name);
    const addonIcon = ui.container.querySelector("svg.lucide-layers");
    expect(addonIcon instanceof SVGElement).toBe(true);
    expect(paintedColor(addonIcon)).toBe(
      expectedColor(resolveMatterColor(LEASE.id, LEASE.color)),
    );
  });
});
