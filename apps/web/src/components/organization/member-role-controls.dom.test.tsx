import type { ReactElement } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import * as v from "valibot";

import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";
import { assignableRoles } from "@stll/permissions";

import messages from "@/i18n/langs/en.json";
import type { Role } from "@/lib/auth-client";
import { inviteMemberSchema } from "@/lib/organization/role-assignment.logic";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({
  url: "http://localhost:3000/settings/organization/members",
});

const originalFetch = globalThis.fetch;
const requests: { path: string; body: unknown }[] = [];
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/api/auth/get-session") {
      return Response.json(null);
    }
    const body: unknown = await request.json();
    requests.push({ path, body });
    return Response.json({
      id: "membership-change",
      ...v.parse(v.record(v.string(), v.unknown()), body),
    });
  },
  { preconnect: () => undefined },
);

const { act } = await import("react");
const { cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { roleOptions } = await import("@/lib/auth-queries");
const { InviteMemberDialog } = await import("./invite-member-dialog");
const { RoleCell } =
  await import("@/routes/_protected.settings/-components/organization/member-role-cell");

const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(async () => {
  await act(async () => {
    cleanup();
  });
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  requests.length = 0;
});
afterAll(async () => {
  await act(async () => {
    cleanup();
  });
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const mount = (actorRole: Role, children: ReactElement) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  client.setQueryData(roleOptions.queryKey, actorRole);
  return render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        {children}
      </IntlProvider>
    </QueryClientProvider>,
  );
};

const openPicker = async () => {
  await act(async () => {
    fireEvent.mouseDown(screen.getByRole("combobox"), { button: 0 });
  });
  return await screen.findAllByRole("option");
};

const optionValues = (options: HTMLElement[]) =>
  options.map((option) => {
    expect(option.getAttribute("aria-disabled")).not.toBe("true");
    expect(Object.hasOwn(option.dataset, "disabled")).toBe(false);
    const role = ORGANIZATION_ROLE_NAMES.find(
      (value) =>
        within(option).queryByText(messages.organization.roles[value], {
          exact: true,
        }) !== null,
    );
    expect(role).toBeDefined();
    return role;
  });

const chooseRole = async (options: HTMLElement[], role: Role) => {
  const index = optionValues(options).indexOf(role);
  const option = index === -1 ? undefined : options.at(index);
  if (option === undefined) {
    panic("Expected role option is unavailable");
  }
  await act(async () => {
    fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 });
    fireEvent.click(option);
  });
};

const openInvite = async () => {
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: messages.common.invite }),
    );
  });
  await screen.findByRole("dialog");
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "member@example.com" },
  });
};

const submitInvitation = async () => {
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", {
        name: messages.organization.invitations.sendInvitation,
      }),
    );
  });
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests.at(0)?.path).toBe("/api/auth/organization/invite-member");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
};

describe("mounted membership role controls", () => {
  for (const actorRole of ORGANIZATION_ROLE_NAMES) {
    test(`${actorRole} sees invitation options equal to the accepted form roles`, async () => {
      const expected = [...assignableRoles(actorRole)];
      const schema = inviteMemberSchema(actorRole);
      expect(
        ORGANIZATION_ROLE_NAMES.filter(
          (role) =>
            v.safeParse(schema, { email: "member@example.com", role }).success,
        ),
      ).toEqual(expected);
      const view = mount(actorRole, <InviteMemberDialog />);
      if (expected.length === 0) {
        expect(view.queryByRole("button")).toBeNull();
        expect(view.queryByRole("combobox")).toBeNull();
        return;
      }
      await openInvite();
      expect(optionValues(await openPicker())).toEqual(expected);
    });

    if (assignableRoles(actorRole).length > 0) {
      test(`${actorRole} submits a default taken from its assignment policy`, async () => {
        mount(actorRole, <InviteMemberDialog />);
        await openInvite();
        await submitInvitation();
        expect(requests.at(0)?.body).toMatchObject({
          email: "member@example.com",
          role: assignableRoles(actorRole).at(-1),
        });
      });
    }

    for (const targetRole of assignableRoles(actorRole)) {
      test(`${actorRole} submits the rendered ${targetRole} invitation option`, async () => {
        mount(actorRole, <InviteMemberDialog />);
        await openInvite();
        await chooseRole(await openPicker(), targetRole);
        await submitInvitation();
        expect(requests.at(0)?.body).toMatchObject({
          email: "member@example.com",
          role: targetRole,
        });
      });

      test(`${actorRole} submits the rendered ${targetRole} member-role option`, async () => {
        const memberRole =
          assignableRoles(actorRole).find((role) => role !== targetRole) ??
          panic("A role update needs a different initial role");
        mount(
          actorRole,
          <RoleCell
            currentUserRole={actorRole}
            isSelf={false}
            memberEmail="member@example.com"
            memberId="member-row"
            memberRole={memberRole}
          />,
        );
        await chooseRole(await openPicker(), targetRole);
        await screen.findByRole("alertdialog");
        fireEvent.change(screen.getByRole("textbox"), {
          target: { value: "member@example.com" },
        });
        const confirmation = screen.getByRole("button", {
          name: messages.organization.members.changeRole,
        });
        expect(confirmation.hasAttribute("disabled")).toBe(false);
        await act(async () => {
          fireEvent.click(confirmation);
        });
        await waitFor(() => expect(requests).toHaveLength(1));
        expect(requests.at(0)?.path).toBe(
          "/api/auth/organization/update-member-role",
        );
        expect(requests.at(0)?.body).toMatchObject({
          memberId: "member-row",
          role: targetRole,
        });
        await waitFor(() =>
          expect(screen.queryByRole("alertdialog")).toBeNull(),
        );
      });
    }

    for (const memberRole of ORGANIZATION_ROLE_NAMES) {
      test(`${actorRole} edits ${memberRole} only within its assignment policy`, async () => {
        const expected = [...assignableRoles(actorRole)];
        const view = mount(
          actorRole,
          <RoleCell
            currentUserRole={actorRole}
            isSelf={false}
            memberEmail="member@example.com"
            memberId="member-row"
            memberRole={memberRole}
          />,
        );
        if (!expected.includes(memberRole)) {
          expect(view.queryByRole("combobox")).toBeNull();
          expect(
            view.getByText(messages.organization.roles[memberRole]),
          ).toBeDefined();
          return;
        }
        expect(optionValues(await openPicker())).toEqual(expected);
      });
    }

    test(`${actorRole} leaves its own role read-only`, () => {
      const view = mount(
        actorRole,
        <RoleCell
          currentUserRole={actorRole}
          isSelf
          memberEmail="member@example.com"
          memberId="member-row"
          memberRole={actorRole}
        />,
      );
      expect(view.queryByRole("combobox")).toBeNull();
    });
  }
});
