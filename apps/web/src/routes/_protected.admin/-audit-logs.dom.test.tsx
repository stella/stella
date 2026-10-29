import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { AuditResource } from "@stll/api-contract/audit-log";

import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { AuditResourceLabel } = await import("./audit-logs");

afterEach(cleanup);
afterAll(async () => await unregisterDomEnvironment());

test("the truncated resource id exposes its full labelled value", () => {
  const resource = {
    kind: "unknown",
    rawKind: "retired_record_kind",
    id: "resource_1234567890",
    name: null,
    available: false,
  } as const satisfies AuditResource;
  const view = render(
    <IntlProvider locale="en" messages={messages}>
      <AuditResourceLabel action="update" resource={resource} />
    </IntlProvider>,
  );

  const accessibleId = view.getByText("Resource ID: resource_1234567890");
  expect(accessibleId.classList.contains("sr-only")).toBe(true);
  expect(view.getByText("resource").getAttribute("aria-hidden")).toBe("true");
  // Sighted users can still read and copy the full id from the short one.
  expect(view.getByText("resource").getAttribute("title")).toBe(
    "resource_1234567890",
  );
  expect(view.getByText(/^retired_record_kind/u)).not.toBeNull();
  expect(
    view.getByText(messages.settings.organization.auditLogsUnknownResource),
  ).not.toBeNull();
});
