import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import messages from "@/i18n/langs/en.json";
import { toSafeId } from "@/lib/safe-id";
import type { ApprovalEntry, ApprovalResult } from "@/lib/time-approval-queue";

import { ApprovalTable } from "./approval-table";

const entry = {
  id: toSafeId<"timeEntry">("entry-a"),
  workspaceId: toSafeId<"workspace">("matter-a"),
  userId: "member-a",
  dateWorked: "2026-09-30",
  timezoneId: "UTC",
  durationMinutes: 45,
  billedMinutes: 60,
  narrative: "Preparing a submission",
  billable: true,
  status: "draft",
  approverUserId: "reviewer-a",
  approvedByUserId: null,
  approvedAt: null,
  returnedAt: null,
  returnedByUserId: null,
  returnComment: "Clarify the work performed.",
} satisfies ApprovalEntry;

type RenderOptions = {
  entries?: ApprovalEntry[];
  results?: ApprovalResult[];
  pending?: boolean;
  loading?: boolean;
};
const render = ({
  entries = [entry],
  results = [],
  pending = false,
  loading = false,
}: RenderOptions = {}) =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <ApprovalTable
        entries={entries}
        results={results}
        selectedIds={[entry.id]}
        pending={pending}
        loading={loading}
        members={new Map([["member-a", "Timekeeper"]])}
        matters={new Map([["matter-a", "Litigation matter"]])}
        onSelectedIdsChange={() => undefined}
        onApprove={() => undefined}
        onReturn={() => undefined}
      />
    </IntlProvider>,
  );

describe("approval queue table", () => {
  test("shows logged duration separately from billed minutes and preserves the return comment", () => {
    const markup = render();
    for (const text of [
      messages.organization.roles.member,
      messages.billing.narrative,
      messages.billing.approvalQueue.logged,
      messages.billing.approvalQueue.billed,
      "45 min",
      "60 min",
      "Timekeeper",
      "Litigation matter",
      entry.narrative,
      entry.returnComment,
      messages.billing.statuses.draft,
    ]) {
      expect(markup).toContain(text);
    }
    expect(markup).toContain(messages.billing.approveSelected);
    expect(markup).toContain(messages.billing.approvalQueue.approveVisible);
    expect(markup).toContain('role="checkbox"');
  });

  test("shows typed refusals inline alongside the retained entry", () => {
    const markup = render({
      results: [
        { id: entry.id, status: "refused", reason: "time_period_locked" },
      ],
    });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain(
      messages.billing.approvalQueue.refusals.time_period_locked,
    );
    expect(markup).toContain(entry.narrative);
    expect(markup).toContain(entry.returnComment);
  });

  test("disables selection and approval controls while a batch is pending", () => {
    const markup = render({ pending: true });
    expect(markup).toContain('disabled=""');
    expect(markup).toContain(entry.narrative);
  });

  test("loading preserves the real headers and gives every skeleton row the same column count", () => {
    const loaded = render();
    const loading = render({ entries: [], loading: true });
    const headers = (markup: string) =>
      [...markup.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gu)].map((match) =>
        match.at(1),
      );
    expect(headers(loading)).toHaveLength(headers(loaded).length);
    expect(headers(loading).slice(1)).toEqual(headers(loaded).slice(1));
    const columnCount = headers(loaded).length;
    expect(columnCount).toBeGreaterThan(0);
    const skeletonRows = [
      ...loading.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gu),
    ].slice(1);
    expect(skeletonRows).toHaveLength(3);
    for (const row of skeletonRows) {
      expect((row.at(1)?.match(/<td\b/gu) ?? []).length).toBe(columnCount);
    }
    expect(loading).not.toContain(messages.billing.approvalQueue.empty);
    expect(loading).not.toContain(entry.narrative);
  });

  test("renders the queue empty state", () => {
    expect(render({ entries: [] })).toContain(
      messages.billing.approvalQueue.empty,
    );
  });
});
