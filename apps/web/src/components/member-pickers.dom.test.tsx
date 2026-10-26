import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import * as v from "valibot";

import type { ContactData } from "@/routes/_protected.contacts/-components/types";
import { unregisterDomEnvironment } from "@/test-dom-environment";

// Every surface that asks for a person saves the member chosen in its
// MemberCombobox. The server is a stub keyed by request path: reads answer
// with fixtures, writes are recorded so each test asserts what was sent.

GlobalRegistrator.register({ url: "http://localhost:3000/", width: 1280 });

type Write = { method: string; path: string; body: Record<string, unknown> };
const writes: Write[] = [];
let reads: { pattern: RegExp; body: unknown }[] = [];

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method === "GET") {
      const read = reads.find(({ pattern }) => pattern.test(path));
      if (read === undefined) {
        // An unexpected read stays pending, so it never overwrites a fixture.
        return await new Promise<Response>(() => {});
      }
      return Response.json(read.body);
    }
    const text = await request.text();
    writes.push({
      method: request.method,
      path,
      body: v.parse(
        v.record(v.string(), v.unknown()),
        text === "" ? {} : JSON.parse(text),
      ),
    });
    return Response.json({});
  },
  { preconnect: () => undefined },
);

const testing = await import("@testing-library/react");
const query = await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { Suspense, useState } = await import("react");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { AddMemberDialog } =
  await import("@/components/workspaces/add-member-dialog");
const { LeadSection } = await import("@/components/workspaces/lead-section");
const { AssigneePicker } =
  await import("@/components/workspaces/tasks/task-metadata");
const { CorrespondenceAssigneeField } =
  await import("@/routes/_protected.workspaces/$workspaceId/-components/correspondence-assignee-field");
const { ContactOwnersEditor } =
  await import("@/routes/_protected.contacts/-components/contact-owners-editor");
const { RateManagementDialog } =
  await import("@/routes/_protected.workspaces/$workspaceId/-components/billing/rate-management-dialog");
const { toSafeId } = await import("@/lib/safe-id");
const { DeletionTaskReassignments } =
  await import("@/routes/_protected.settings/-components/account/deletion-task-reassignments");

const ORGANIZATION = "00000000-0000-7000-8000-00000000f001";
const WORKSPACE = "00000000-0000-7000-8000-00000000f002";
const TASK = "00000000-0000-7000-8000-00000000f003";
const CORRESPONDENCE = "00000000-0000-7000-8000-00000000f004";
const CONTACT = "00000000-0000-7000-8000-00000000f005";
const RATE_TABLE = "00000000-0000-7000-8000-00000000f006";

const person = (suffix: string, name: string, email: string) => ({
  id: `00000000-0000-7000-8000-0000000000${suffix}`,
  name,
  email,
  image: null,
});
const DVORAK = person("a1", "Eva Dvořák", "eva@kancelar.example");
const HORAK = person("a2", "Tomáš Horák", "th@kancelar.example");
const PEOPLE = [DVORAK, HORAK];

const organizationRead = {
  pattern: /\/organization\/get-full-organization$/u,
  body: {
    id: ORGANIZATION,
    name: "Kancelář",
    slug: "kancelar",
    createdAt: "2026-01-01T00:00:00.000Z",
    invitations: [],
    members: PEOPLE.map((user) => ({
      id: `member-${user.id}`,
      organizationId: ORGANIZATION,
      role: "member",
      createdAt: "2026-01-01T00:00:00.000Z",
      userId: user.id,
      user,
    })),
  },
};
const roleRead = {
  pattern: /\/organization\/get-active-member-role$/u,
  body: { role: "owner" },
};
const matterMembersRead = (people: readonly (typeof DVORAK)[]) => ({
  pattern: new RegExp(`/workspaces/${WORKSPACE}/members$`, "u"),
  body: people.map((user) => ({
    id: `workspace-member-${user.id}`,
    userId: user.id,
    createdAt: "2026-01-01T00:00:00.000Z",
    user,
  })),
});

const clients: InstanceType<typeof query.QueryClient>[] = [];
afterEach(() => {
  testing.cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  writes.length = 0;
  reads = [];
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

/** Mounts `children` under the app's providers and a signed-in route. */
const mount = async (children: () => ReactNode) => {
  const client = new query.QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  const root = router.createRootRoute({ component: router.Outlet });
  const protectedRoute = router.createRoute({
    getParentRoute: () => root,
    id: "_protected",
    beforeLoad: () => ({ user: { activeOrganizationId: ORGANIZATION } }),
  });
  const page = router.createRoute({
    getParentRoute: () => protectedRoute,
    path: "/",
    component: () => <Suspense fallback={null}>{children()}</Suspense>,
  });
  const appRouter = router.createRouter({
    routeTree: root.addChildren([protectedRoute.addChildren([page])]),
    history: router.createMemoryHistory({ initialEntries: ["/"] }),
    isServer: false,
  });
  await appRouter.load();
  return testing.render(
    <query.QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <AuthenticatedUserProvider
            user={{
              activeOrganizationId: ORGANIZATION,
              email: "owner@kancelar.example",
              id: "00000000-0000-7000-8000-0000000000ff",
              image: null,
              name: "Owner",
              preferredName: null,
              timezoneId: "UTC",
              wordEditShortcut: null,
            }}
          >
            <router.RouterProvider router={appRouter} />
          </AuthenticatedUserProvider>
        </FormattingProvider>
      </IntlProvider>
    </query.QueryClientProvider>,
  );
};

const pickerInput = async (name: string) => {
  const input = await testing.screen.findByRole("combobox", { name });
  if (!(input instanceof HTMLInputElement)) {
    throw new TypeError(`Expected the ${name} picker input`);
  }
  await testing.waitFor(() => expect(input.disabled).toBe(false));
  return input;
};

/** Types a search, then picks the one match with the keyboard. */
const choose = async (input: HTMLInputElement, search: string) => {
  await testing.act(async () => {
    input.focus();
    testing.fireEvent.input(input, {
      target: { value: search },
      inputType: "insertText",
    });
  });
  await testing.waitFor(() =>
    expect(testing.screen.getAllByRole("option")).toHaveLength(1),
  );
  await testing.act(async () => {
    testing.fireEvent.keyDown(input, { key: "ArrowDown" });
  });
  await testing.act(async () => {
    testing.fireEvent.keyDown(input, { key: "Enter" });
  });
};

const sent = async (method: string, path: RegExp) =>
  await testing.waitFor(() => {
    const write = writes.find(
      (entry) => entry.method === method && path.test(entry.path),
    );
    expect(write).toBeDefined();
    return write?.body ?? {};
  });

describe("member pickers save the chosen member", () => {
  test("adding a matter member: existing members are disabled; Enter picks, Enter adds", async () => {
    reads = [organizationRead, roleRead, matterMembersRead([HORAK])];
    await mount(() => (
      <AddMemberDialog
        onOpenChange={() => {}}
        open={true}
        workspaceId={WORKSPACE}
      />
    ));
    const input = await pickerInput(messages.workspaces.members.addMember);

    await testing.act(async () => {
      input.focus();
      testing.fireEvent.input(input, {
        target: { value: "horak" },
        inputType: "insertText",
      });
    });
    const existing = await testing.screen.findByRole("option");
    expect(existing.textContent).toContain(
      messages.workspaces.members.alreadyOnMatter,
    );
    expect(existing.getAttribute("aria-disabled")).toBe("true");

    await choose(input, "dvorak");
    await testing.waitFor(() => expect(input.value).toBe(DVORAK.name));
    expect(writes).toEqual([]);
    await testing.act(async () => {
      testing.fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(await sent("PUT", /\/members$/u)).toEqual({ userId: DVORAK.id });
  });

  test("matter lead", async () => {
    reads = [
      roleRead,
      matterMembersRead(PEOPLE),
      {
        pattern: new RegExp(`/workspaces/${WORKSPACE}$`, "u"),
        body: { id: WORKSPACE, name: "Novák v. Horák", leadUserId: null },
      },
    ];
    await mount(() => <LeadSection workspaceId={WORKSPACE} />);
    await choose(await pickerInput(messages.workspaces.lead), "dvorak");

    expect(
      await sent("POST", new RegExp(`/workspaces/${WORKSPACE}$`, "u")),
    ).toEqual({ leadUserId: DVORAK.id });
  });

  test("task assignee", async () => {
    reads = [roleRead, matterMembersRead(PEOPLE)];
    await mount(() => (
      <AssigneePicker assignees={[]} taskId={TASK} workspaceId={WORKSPACE} />
    ));
    const trigger = await testing.screen.findByRole("button", {
      name: messages.tasks.addAssignee,
    });
    await testing.act(async () => {
      testing.fireEvent.click(trigger);
    });
    await choose(await pickerInput(messages.tasks.addAssignee), "dvorak");

    expect(await sent("POST", /\/assignees$/u)).toEqual({
      taskId: TASK,
      userId: DVORAK.id,
    });
  });

  test("correspondence assignee, and the unassigned row", async () => {
    reads = [roleRead, matterMembersRead(PEOPLE)];
    await mount(() => (
      <CorrespondenceAssigneeField
        assigneeId={HORAK.id}
        correspondenceId={CORRESPONDENCE}
        workspaceId={WORKSPACE}
      />
    ));
    const input = await pickerInput(messages.common.assignee);
    await choose(input, "dvorak");
    expect(await sent("PATCH", /\/correspondence\/[^/]+$/u)).toEqual({
      assigneeId: DVORAK.id,
    });

    writes.length = 0;
    await choose(input, "unassig");
    expect(await sent("PATCH", /\/correspondence\/[^/]+$/u)).toEqual({
      assigneeId: null,
    });
  });

  test("contact owner", async () => {
    reads = [organizationRead, roleRead];
    await mount(() => <ContactOwnersEditor contact={contactFixture} />);
    await choose(
      await pickerInput(messages.contacts.attorneys.responsible),
      "dvorak",
    );

    expect(
      await sent("POST", new RegExp(`/contacts/${CONTACT}$`, "u")),
    ).toEqual({ responsibleAttorneyId: DVORAK.id });
  });

  test("rate entry holder", async () => {
    reads = [
      organizationRead,
      roleRead,
      {
        pattern: /\/entries$/u,
        body: { items: [] },
      },
      {
        pattern: new RegExp(`/rates/${WORKSPACE}$`, "u"),
        body: {
          items: [
            {
              id: RATE_TABLE,
              name: "Standard",
              currency: "CZK",
              isDefault: true,
              entryCount: 0,
            },
          ],
        },
      },
    ];
    await mount(() => (
      <RateManagementDialog
        onOpenChange={() => {}}
        open={true}
        workspaceId={WORKSPACE}
      />
    ));
    const table = await testing.screen.findByText("Standard");
    await testing.act(async () => {
      testing.fireEvent.click(table);
    });
    const addRate = await testing.screen.findByRole("button", {
      name: messages.billing.rates.addRate,
    });
    await testing.act(async () => {
      testing.fireEvent.click(addRate);
    });
    await choose(await pickerInput(messages.common.user), "dvorak");
    const rate = testing.screen.getByPlaceholderText("350.00");
    await testing.act(async () => {
      testing.fireEvent.change(rate, { target: { value: "2500" } });
    });
    await testing.act(async () => {
      testing.fireEvent.click(
        testing.screen.getByRole("button", { name: messages.common.save }),
      );
    });

    expect(await sent("PUT", /\/entries$/u)).toMatchObject({
      userId: DVORAK.id,
    });
  });

  test("account deletion: one member takes every task in a matter", async () => {
    const tasks = ["Draft the lease", "File the claim"].map(
      (taskName, index) => ({
        assigneeId: `assignment-${index}`,
        entityId: `task-${index}`,
        role: "assignee" as const,
        taskName,
        workspaceId: WORKSPACE,
        workspaceName: "Novák v. Horák",
      }),
    );
    const seen: Record<string, string>[] = [];
    await mount(() => {
      const [reassignments, setReassignments] = useState<
        Record<string, string>
      >({});
      seen.push(reassignments);
      return (
        <DeletionTaskReassignments
          groups={[
            {
              workspaceId: WORKSPACE,
              workspaceName: "Novák v. Horák",
              tasks,
              members: PEOPLE.map((user) => ({
                workspaceId: WORKSPACE,
                userId: user.id,
                userName: user.name,
              })),
            },
          ]}
          onReassignmentsChange={setReassignments}
          reassignments={reassignments}
        />
      );
    });
    await choose(
      await pickerInput(
        messages.settings.account.deleteAccountTaskBulkReassign,
      ),
      "dvorak",
    );

    await testing.waitFor(() =>
      expect(seen.at(-1)).toEqual({
        "task-0": DVORAK.id,
        "task-1": DVORAK.id,
      }),
    );
  });
});

const contactFixture = {
  id: toSafeId<"contact">(CONTACT),
  organizationId: toSafeId<"organization">(ORGANIZATION),
  type: "person",
  displayName: "Novák s.r.o.",
  prefix: null,
  firstName: null,
  middleName: null,
  lastName: null,
  suffix: null,
  organizationName: null,
  notes: null,
  emails: [],
  phones: [],
  addresses: null,
  tags: null,
  metadata: { version: 1, dataBoxes: [], customFields: [] },
  color: null,
  registrationNumber: null,
  taxId: null,
  vatId: null,
  vatPayer: null,
  invoiceLanguage: null,
  bankAccounts: null,
  billingAddress: null,
  defaultHourlyRate: null,
  currency: null,
  paymentTermDays: null,
  originatingAttorneyId: null,
  responsibleAttorneyId: null,
  originatingAttorney: null,
  responsibleAttorney: null,
  dateOfBirth: null,
  nationalityCodes: [],
  sanctionsMonitoringMode: "included",
  createdBy: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  clientMatterCount: 0,
  clientMatters: [],
  partyCount: 0,
  partyMatters: [],
} satisfies ContactData;
