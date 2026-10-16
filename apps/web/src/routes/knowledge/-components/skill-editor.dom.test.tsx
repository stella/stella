import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
Object.assign(import.meta.env, { VITE_API_URL: "http://localhost:3001" });
const { stellaToast } = await import("@stll/ui/toast");
const { act, cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { roleOptions } = await import("@/lib/auth-queries");
const { skillDetailOptions } = await import("@/lib/knowledge/queries");
const { toSafeId } = await import("@/lib/safe-id");
const { SkillEditor } = await import("./skill-editor");

const SKILL_ID = "019a0000-0000-7000-8000-000000000101";
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

type Invocation = "auto" | "manual";

const skillDetail = (ownerUserId: string, invocation: Invocation) => ({
  id: toSafeId<"agentSkill">(SKILL_ID),
  scope: "private" as const,
  origin: "authored" as const,
  userId: ownerUserId,
  slug: "clause-review",
  name: "Clause review",
  description: "Checks clauses against the house rules.",
  version: null,
  license: null,
  compatibility: null,
  sourceUrl: null,
  contentHash: "hash",
  enabled: true,
  invocation,
  body: "Instructions",
  command: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  resources: [],
});

type PatchRequest = { method: string; pathname: string; body: unknown };

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

type MountOptions = {
  /** Owner of the private skill; another user cannot edit it. */
  ownerUserId?: string;
  /** HTTP status the PATCH answers with. */
  patchStatus?: number;
};

const mount = ({
  ownerUserId = user.id,
  patchStatus = 200,
}: MountOptions = {}) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  client.setQueryData(roleOptions.queryKey, "member");
  let current = skillDetail(ownerUserId, "auto");
  client.setQueryData(
    skillDetailOptions(user.activeOrganizationId, user.id, SKILL_ID).queryKey,
    current,
  );
  const patches: PatchRequest[] = [];
  const boundary = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const pathname = new URL(request.url).pathname;
        if (pathname === `/v1/skills/${SKILL_ID}`) {
          if (request.method === "PATCH") {
            const body: unknown = await request.json();
            patches.push({ method: request.method, pathname, body });
            if (patchStatus !== 200) {
              return Response.json(
                { message: "Refused" },
                { status: patchStatus },
              );
            }
            if (
              typeof body === "object" &&
              body !== null &&
              "invocation" in body &&
              (body.invocation === "auto" || body.invocation === "manual")
            ) {
              current = { ...current, invocation: body.invocation };
            }
            return Response.json(current);
          }
          if (request.method === "GET") {
            return Response.json(current);
          }
        }
        // Lists the editor's neighbours read (catalogue, skills) stay empty.
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
            <SkillEditor skillId={SKILL_ID} />
          </QueryClientProvider>
        </AuthenticatedUserProvider>
      </FormattingProvider>
    </IntlProvider>,
  );
  return patches;
};

const invocationControl = () =>
  screen.getByRole("combobox", {
    name: messages.common.whenToUse,
  });

const choose = async (optionName: string) => {
  await act(async () => {
    fireEvent.mouseDown(invocationControl(), { button: 0 });
  });
  const option = await screen.findByRole("option", { name: optionName });
  await act(async () => {
    fireEvent.pointerDown(option, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(option, { button: 0, pointerType: "mouse" });
    fireEvent.click(option, { button: 0, detail: 1 });
  });
};

test("the invocation control shows the skill's current setting", () => {
  mount();
  expect(invocationControl().textContent).toContain(
    messages.knowledge.agentSkills.invocationAuto,
  );
  expect(
    screen.getByText(messages.knowledge.agentSkills.invocationAutoHelp),
  ).toBeTruthy();
  expect(invocationControl().hasAttribute("disabled")).toBe(false);
});

test("choosing only when invoked saves the manual invocation", async () => {
  const patches = mount();
  await choose(messages.knowledge.agentSkills.invocationManual);
  await waitFor(() => {
    expect(patches).toEqual([
      {
        method: "PATCH",
        pathname: `/v1/skills/${SKILL_ID}`,
        body: { invocation: "manual" },
      },
    ]);
  });
  await waitFor(() => {
    expect(invocationControl().textContent).toContain(
      messages.knowledge.agentSkills.invocationManual,
    );
  });
  expect(
    screen.getByText(messages.knowledge.agentSkills.invocationManualHelp),
  ).toBeTruthy();
});

test("a refused invocation change snaps back to the saved setting", async () => {
  const toast = spyOn(stellaToast, "add").mockReturnValue("failure");
  spies.push(toast);
  const patches = mount({ patchStatus: 500 });
  await choose(messages.knowledge.agentSkills.invocationManual);
  await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
  expect(patches).toHaveLength(1);
  await waitFor(() => {
    expect(invocationControl().textContent).toContain(
      messages.knowledge.agentSkills.invocationAuto,
    );
  });
});

test("the invocation control is disabled for someone who cannot edit the skill", () => {
  const patches = mount({ ownerUserId: "someone-else" });
  expect(invocationControl().hasAttribute("disabled")).toBe(true);
  expect(patches).toEqual([]);
});
