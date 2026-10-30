import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import messages from "@/i18n/langs/en.json";
import type { WorkspaceNavigationItem } from "@/lib/memory-api";
import { toSafeId } from "@/lib/safe-id";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
Object.assign(import.meta.env, { VITE_API_URL: "http://localhost:3001" });
const { act, cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { workspacesNavigationOptions } =
  await import("@/lib/workspaces/queries");
const { groupedChatThreadsOptions } = await import("@/features/chat/queries");
const { BlueprintGallerySheet } = await import("./blueprint-gallery-sheet");

const user = {
  activeOrganizationId: "organization",
  email: "member@example.test",
  id: "user",
  image: null,
  name: "Member",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};

const MATTER_ID = "00000000-0000-7000-8000-0000000000a1";
const MATTER = {
  client: null,
  clientId: null,
  color: null,
  defaultViewId: null,
  id: toSafeId<"workspace">(MATTER_ID),
  lastActivityAt: new Date("2026-10-11T12:00:00.000Z"),
  name: "Novák v. Horák",
  reference: "M-00a1",
  status: "active",
} satisfies WorkspaceNavigationItem;

const tSkills = messages.knowledge.agentSkills;

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

const mount = ({ canManageTeam }: { canManageTeam: boolean }) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  client.setQueryData(
    workspacesNavigationOptions({
      organizationId: user.activeOrganizationId,
      userId: user.id,
    }).queryKey,
    { workspaces: [MATTER], features: { timeBilling: false } },
  );
  // Chat history only reorders the matter picker; an empty history keeps it
  // out of the network.
  const history = groupedChatThreadsOptions({
    activeOrganizationId: user.activeOrganizationId,
    userId: user.id,
  });
  client.setQueryData(history.queryKey, {
    pageParams: [history.initialPageParam],
    pages: [{ global: [], nextCursor: null, workspaces: [] }],
  });
  const created: unknown[] = [];
  const boundary = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const pathname = new URL(request.url).pathname;
        if (pathname === "/v1/skills/from-blueprint") {
          created.push(await request.json());
          return Response.json({ id: "019a0000-0000-7000-8000-000000000101" });
        }
        return Response.json(null);
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
            <BlueprintGallerySheet
              canManageTeam={canManageTeam}
              onCreated={() => undefined}
              onOpenChange={() => undefined}
              open
            />
          </QueryClientProvider>
        </AuthenticatedUserProvider>
      </FormattingProvider>
    </IntlProvider>,
  );
  return created;
};

const availabilityControl = () =>
  screen.getByRole("combobox", { name: tSkills.availabilityLabel });

const openSelect = async (control: HTMLElement) => {
  await act(async () => {
    fireEvent.mouseDown(control, { button: 0 });
  });
};

const pick = async (option: HTMLElement) => {
  await act(async () => {
    fireEvent.pointerDown(option, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(option, { button: 0, pointerType: "mouse" });
    fireEvent.click(option, { button: 0, detail: 1 });
  });
};

/** Whether the open availability list offers each option, by name. */
const offeredAvailabilities = async () => {
  await openSelect(availabilityControl());
  await screen.findByRole("option", { name: tSkills.availabilityMatter });
  return [
    messages.knowledge.skills.form.scopePrivate,
    tSkills.availabilityMatter,
    tSkills.availabilityClient,
  ].filter((name) => screen.queryByRole("option", { name }) !== null);
};

test("a member is not offered binding a skill to a client", async () => {
  mount({ canManageTeam: false });
  expect(await offeredAvailabilities()).toEqual([
    messages.knowledge.skills.form.scopePrivate,
    tSkills.availabilityMatter,
  ]);
});

test("an admin may bind a skill to a client", async () => {
  mount({ canManageTeam: true });
  expect(await offeredAvailabilities()).toEqual([
    messages.knowledge.skills.form.scopePrivate,
    tSkills.availabilityMatter,
    tSkills.availabilityClient,
  ]);
});

test("a member sharing with the team must bind the skill to a matter", async () => {
  mount({ canManageTeam: false });
  await openSelect(
    screen.getByRole("combobox", {
      name: messages.knowledge.skills.form.scope,
    }),
  );
  await pick(
    await screen.findByRole("option", {
      name: messages.knowledge.skills.form.scopeTeam,
    }),
  );
  await waitFor(() => {
    expect(availabilityControl().textContent).toContain(
      tSkills.availabilityMatter,
    );
  });
  expect(screen.getByText(tSkills.availabilityTeamNeedsMatter)).toBeTruthy();
  // No matter chosen yet, so nothing can be created.
  const blank = screen.getByRole("button", {
    name: new RegExp(
      messages.knowledge.skills.blueprintGallery.startBlank,
      "u",
    ),
  });
  expect(blank.hasAttribute("disabled")).toBe(true);
});

test("a skill created for one matter carries the matter's id", async () => {
  const created = mount({ canManageTeam: false });
  await openSelect(availabilityControl());
  await pick(
    await screen.findByRole("option", { name: tSkills.availabilityMatter }),
  );
  const matterInput = await screen.findByPlaceholderText(
    messages.common.selectAMatter,
  );
  await act(async () => {
    matterInput.focus();
    fireEvent.keyDown(matterInput, { key: "ArrowDown" });
  });
  await pick(await screen.findByRole("option", { name: /Novák v\. Horák/u }));
  const blank = screen.getByRole("button", {
    name: new RegExp(
      messages.knowledge.skills.blueprintGallery.startBlank,
      "u",
    ),
  });
  await waitFor(() => expect(blank.hasAttribute("disabled")).toBe(false));
  await act(async () => {
    fireEvent.click(blank);
  });
  await waitFor(() => {
    expect(created).toEqual([
      {
        blueprintId: "blank",
        boundWorkspaceId: MATTER_ID,
        scope: "private",
      },
    ]);
  });
});
