import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import messages from "@/i18n/langs/en.json" with { type: "json" };
import { unregisterDomEnvironment } from "@/test-dom-environment";

import type { MemberInvitation } from "./members-invitations";

GlobalRegistrator.register({ url: "http://localhost:3000/admin/members" });
const { cleanup, fireEvent, render, screen, within, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { TooltipProvider } = await import("@stll/ui/tooltip");
const { MembersInvitations } = await import("./members-invitations");

afterEach(cleanup);
afterAll(async () => {
  await unregisterDomEnvironment();
});

const NOW = new Date("2026-10-30T12:00:00Z");
const base = { role: "member", createdAt: "2024-12-01T12:00:00Z" } as const;
const invitations = [
  {
    ...base,
    id: "open",
    email: "open@example.com",
    status: "pending",
    expiresAt: "2026-11-01T12:00:00Z",
  },
  {
    ...base,
    id: "expired",
    email: "expired@example.com",
    status: "pending",
    expiresAt: "2025-01-01T12:00:00Z",
  },
  {
    ...base,
    id: "accepted",
    email: "accepted@example.com",
    status: "accepted",
    expiresAt: "2025-01-01T12:00:00Z",
  },
  {
    ...base,
    id: "rejected",
    email: "rejected@example.com",
    status: "rejected",
    expiresAt: "2026-11-01T12:00:00Z",
  },
  {
    ...base,
    id: "canceled",
    email: "canceled@example.com",
    status: "canceled",
    expiresAt: "2026-11-01T12:00:00Z",
  },
] satisfies MemberInvitation[];

test("only open invitations count as pending; history excludes accepted and lets expired invites be resent", async () => {
  const resent: MemberInvitation[] = [];
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <TooltipProvider>
          <MembersInvitations
            invitations={invitations}
            now={NOW}
            onResend={(invitation) => resent.push(invitation)}
            onCancel={() => {}}
            resendPending={false}
            cancelPending={false}
          />
        </TooltipProvider>
      </FormattingProvider>
    </IntlProvider>,
  );
  const pending = screen.getByRole("region", {
    name: messages.settings.organization.pendingInvitations,
  });
  expect(within(pending).getByText("open@example.com")).toBeDefined();
  expect(within(pending).getByRole("heading").textContent).toContain("1");
  expect(screen.queryByText("accepted@example.com")).toBeNull();
  expect(screen.queryByText("expired@example.com")).toBeNull();
  const disclosure = screen.getByRole("button", { name: /Past invitations/u });
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(disclosure);
  const past = screen.getByRole("region", {
    name: messages.settings.organization.pastInvitations,
  });
  expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  expect(within(past).getByText("rejected@example.com")).toBeDefined();
  expect(within(past).getByText("canceled@example.com")).toBeDefined();
  expect(screen.queryByText("accepted@example.com")).toBeNull();
  const row = within(past).getByText("expired@example.com").closest("tr");
  if (!row) {
    throw new TypeError("Expired invitation must render in a table row");
  }
  expect(
    within(row).getByText(messages.organization.invitations.statuses.expired),
  ).toBeDefined();
  fireEvent.click(
    within(row).getByRole("button", { name: messages.common.actions }),
  );
  const resend = await screen.findByRole("menuitem", {
    name: messages.organization.invitations.resendInvitation,
  });
  expect(resend.getAttribute("aria-disabled")).not.toBe("true");
  fireEvent.click(resend);
  await waitFor(() => expect(resent.map(({ id }) => id)).toEqual(["expired"]));
  fireEvent.click(disclosure);
  expect(screen.queryByText("expired@example.com")).toBeNull();
});
