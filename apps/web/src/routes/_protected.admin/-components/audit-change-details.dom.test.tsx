import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { AUDIT_CHANGES_STATUS } from "@stll/api-contract/audit-log";

import czechMessages from "@/i18n/langs/cs.json";
import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { AuditChangeDetails, AuditChangeSummary } =
  await import("./audit-change-details");

afterEach(cleanup);
afterAll(async () => await unregisterDomEnvironment());

type MountOptions = { locale: string; localizedMessages: typeof messages };
const DEFAULT_MOUNT_OPTIONS = { locale: "en", localizedMessages: messages };
type Props = Parameters<typeof AuditChangeSummary>[0];

const mountSummary = (
  props: Props,
  { locale, localizedMessages }: MountOptions = DEFAULT_MOUNT_OPTIONS,
) =>
  render(
    <IntlProvider locale={locale} messages={localizedMessages}>
      <div data-testid="summary">
        <AuditChangeSummary {...props} />
      </div>
    </IntlProvider>,
  );

const mountDetails = (props: Props) =>
  render(
    <IntlProvider locale="en" messages={messages}>
      <div data-testid="details">
        <AuditChangeDetails {...props} />
      </div>
    </IntlProvider>,
  );

test("unavailable audit details show a muted label distinct from no changes", () => {
  const view = mountSummary({
    changes: null,
    changesStatus: AUDIT_CHANGES_STATUS.featureUnavailable,
  });
  expect(view.getByTestId("summary").textContent).toBe(
    messages.common.detailsHiddenFeatureUnavailable,
  );
});

test("visible entries without changes keep their empty marker", () => {
  const view = mountSummary({
    changes: null,
    changesStatus: AUDIT_CHANGES_STATUS.visible,
  });
  expect(view.getByTestId("summary").textContent).toBe("-");
});

test("the summary reads the first change as before and after, then counts the rest", () => {
  const view = mountSummary({
    changes: {
      status: { old: "completed", new: "pending" },
      editionId: { old: null, new: "2026-10" },
    },
    changesStatus: AUDIT_CHANGES_STATUS.visible,
  });
  expect(view.getByTestId("summary").textContent).toBe(
    "status: completed → pending+1 more",
  );
});

test("the details list every field with both sides, empty sides labelled", () => {
  const view = mountDetails({
    changes: {
      status: { old: "completed", new: "pending" },
      editionId: { old: null, new: "2026-10" },
    },
    changesStatus: AUDIT_CHANGES_STATUS.visible,
  });
  const rows = view.getAllByRole("row").map((row) => row.textContent);
  expect(rows).toEqual([
    "FieldBeforeAfter",
    "statuscompletedpending",
    `editionId${messages.settings.organization.auditLogsEmptyValue}2026-10`,
  ]);
});

test("unavailable label uses the selected locale", () => {
  const view = mountSummary(
    { changes: null, changesStatus: AUDIT_CHANGES_STATUS.featureUnavailable },
    { locale: "cs", localizedMessages: czechMessages },
  );
  expect(view.getByTestId("summary").textContent).toBe(
    czechMessages.common.detailsHiddenFeatureUnavailable,
  );
});
