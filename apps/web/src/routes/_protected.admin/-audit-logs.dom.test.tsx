import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { AuditResource } from "@stll/api-contract/audit-log";

import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { AuditActionSentence, AuditResourceLabel } =
  await import("./audit-logs");

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
  // Sighted users see the id truncated by CSS, so selecting and copying it
  // yields the complete value; the tooltip shows it too.
  const visibleId = view.getByText("resource_1234567890");
  expect(visibleId.getAttribute("aria-hidden")).toBe("true");
  expect(visibleId.getAttribute("title")).toBe("resource_1234567890");
  expect(visibleId.textContent).toBe("resource_1234567890");
  expect(view.getByText(/^retired_record_kind/u)).not.toBeNull();
  expect(
    view.getByText(messages.settings.organization.auditLogsUnknownResource),
  ).not.toBeNull();
});

test("an action the log does not recognise stays visible", () => {
  const resource = {
    kind: "contact",
    id: "resource_1234567890",
    name: "Acme",
    available: true,
  } as const satisfies AuditResource;
  const view = render(
    <IntlProvider locale="en" messages={messages}>
      <AuditActionSentence
        action="contact.retired_action"
        resource={resource}
      />
    </IntlProvider>,
  );

  expect(view.getByText("contact.retired_action")).not.toBeNull();
});
