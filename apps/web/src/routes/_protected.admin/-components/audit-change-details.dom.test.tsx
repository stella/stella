import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { AUDIT_CHANGES_STATUS } from "@stll/api-contract/audit-log";

import czechMessages from "@/i18n/langs/cs.json";
import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { AuditChangeDetails } = await import("./audit-change-details");

afterEach(cleanup);
afterAll(async () => await unregisterDomEnvironment());

type MountOptions = { locale: string; localizedMessages: typeof messages };
const DEFAULT_MOUNT_OPTIONS = { locale: "en", localizedMessages: messages };
const mount = (
  props: Parameters<typeof AuditChangeDetails>[0],
  { locale, localizedMessages }: MountOptions = DEFAULT_MOUNT_OPTIONS,
) =>
  render(
    <IntlProvider locale={locale} messages={localizedMessages}>
      <table>
        <tbody>
          <tr>
            <AuditChangeDetails {...props} />
          </tr>
        </tbody>
      </table>
    </IntlProvider>,
  );

test("unavailable audit details show a muted label distinct from no changes", () => {
  const view = mount({
    changes: null,
    changesStatus: AUDIT_CHANGES_STATUS.featureUnavailable,
  });
  const cell = view.getByRole("cell");
  expect(cell.textContent).toBe(
    messages.common.detailsHiddenFeatureUnavailable,
  );
  expect(cell.classList.contains("text-muted-foreground")).toBe(true);
  expect(cell.getAttribute("title")).toBeNull();
});

test("visible entries without changes keep their empty marker", () => {
  const view = mount({
    changes: null,
    changesStatus: AUDIT_CHANGES_STATUS.visible,
  });
  expect(view.getByRole("cell").textContent).toBe("-");
  expect(
    view.queryByText(messages.common.detailsHiddenFeatureUnavailable),
  ).toBeNull();
});

test("visible changes render every field as a labelled before-and-after row", () => {
  const changes = {
    amount: { old: 100, new: 200 },
    due_date: { old: "2026-01-01", new: "2026-02-01" },
    clientName: { old: "Northwind", new: "Contoso" },
  };
  const view = mount({ changes, changesStatus: AUDIT_CHANGES_STATUS.visible });
  expect(view.getAllByRole("term").map((term) => term.textContent)).toEqual([
    "Amount",
    "Due date",
    "Client Name",
  ]);
  expect(view.getAllByRole("definition")).toHaveLength(3);
  expect(view.getByText(messages.common.details)).not.toBeNull();
  expect(view.container.querySelector("pre")?.textContent).toBe(
    JSON.stringify(changes, null, 2),
  );
});

test("unavailable label uses the selected locale", () => {
  const view = mount(
    { changes: null, changesStatus: AUDIT_CHANGES_STATUS.featureUnavailable },
    { locale: "cs", localizedMessages: czechMessages },
  );
  expect(view.getByRole("cell").textContent).toBe(
    czechMessages.common.detailsHiddenFeatureUnavailable,
  );
});
