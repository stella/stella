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

test("changes for an unrecognized resource show a withheld note", () => {
  const view = mount({
    changes: null,
    changesStatus: AUDIT_CHANGES_STATUS.unrecognizedResource,
  });
  const cell = view.getByRole("cell");
  expect(cell.textContent).toBe(
    messages.common.detailsHiddenUnrecognizedResource,
  );
  expect(cell.classList.contains("text-muted-foreground")).toBe(true);
});

test("visible changes render old and new envelopes", () => {
  const changes = {
    amount: { old: 100, new: 200 },
  };
  const view = mount({ changes, changesStatus: AUDIT_CHANGES_STATUS.visible });
  expect(view.getByRole("term").textContent).toBe("Amount");
  expect(view.getByRole("definition").textContent).toBe("100 → 200");
  expect(view.getByText(messages.common.details)).not.toBeNull();
  expect(view.container.querySelector("pre")?.textContent).toBe(
    JSON.stringify(changes, null, 2),
  );
});

test("visible changes render before and after envelopes", () => {
  const view = mount({
    changes: {
      due_date: { before: "2026-01-01", after: "2026-02-01" },
    },
    changesStatus: AUDIT_CHANGES_STATUS.visible,
  });
  expect(view.getByRole("term").textContent).toBe("Due date");
  expect(view.getByRole("definition").textContent).toBe(
    "2026-01-01 → 2026-02-01",
  );
});

test("visible changes render object-valued fields as the new value", () => {
  const view = mount({
    changes: { metadata: { category: "legal" } },
    changesStatus: AUDIT_CHANGES_STATUS.visible,
  });
  expect(view.getByRole("term").textContent).toBe("Metadata");
  expect(view.getByRole("definition").textContent).toBe(
    '— → {"category":"legal"}',
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
