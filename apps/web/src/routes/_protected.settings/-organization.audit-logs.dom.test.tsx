import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { AUDIT_RESOURCE_TYPE } from "@stll/api-contract/audit-log";
import type { AuditResource } from "@stll/api-contract/audit-log";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import messages from "@/i18n/langs/en.json";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { resolveAuditResourceTypeFilter } =
  await import("./-organization.audit-logs.logic");
const { AuditActionSentence, AuditResourceLabel } =
  await import("./-organization.audit-logs.page");

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
  // yields the complete value; the shared truncated text shows it in a
  // tooltip when it overflows.
  const visibleId = view.getByText("resource_1234567890");
  expect(visibleId.getAttribute("aria-hidden")).toBe("true");
  expect(visibleId.dataset["slot"]).toBe("truncated-text");
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

test("a deleted resource without a name says deleted once", () => {
  const resource = {
    kind: "contact",
    id: "resource_1234567890",
    name: null,
    available: false,
  } as const satisfies AuditResource;
  const view = render(
    <IntlProvider locale="en" messages={messages}>
      <p data-testid="sentence">
        <AuditActionSentence action="delete" resource={resource} />
      </p>
      <AuditResourceLabel action="delete" resource={resource} />
    </IntlProvider>,
  );

  expect(view.getByTestId("sentence").textContent).toBe("Deleted contact.");
  expect(view.getByText("deleted contact")).not.toBeNull();
});

test("resource type filter translates matter and localized labels to internal resource types", () => {
  expect(resolveAuditResourceTypeFilter("matter")).toBe(
    AUDIT_RESOURCE_TYPE.WORKSPACE,
  );
  expect(resolveAuditResourceTypeFilter("  Matter  ")).toBe(
    AUDIT_RESOURCE_TYPE.WORKSPACE,
  );
  expect(
    resolveAuditResourceTypeFilter("spis", (resourceType) =>
      resourceType === AUDIT_RESOURCE_TYPE.WORKSPACE ? "spis" : resourceType,
    ),
  ).toBe(AUDIT_RESOURCE_TYPE.WORKSPACE);
  expect(resolveAuditResourceTypeFilter("workspace")).toBe(
    AUDIT_RESOURCE_TYPE.WORKSPACE,
  );
  expect(resolveAuditResourceTypeFilter("contact")).toBe(
    AUDIT_RESOURCE_TYPE.CONTACT,
  );
  expect(resolveAuditResourceTypeFilter("   ")).toBeUndefined();
});
