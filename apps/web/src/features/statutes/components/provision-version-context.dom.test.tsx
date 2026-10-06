import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });
const { render, cleanup, fireEvent } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { ProvisionVersionContext } = await import("./provision-version-context");
const messages = (await import("@/i18n/langs/en.json")).default;

const appliedDocumentId = "0198f4c1-2b3d-7a41-9c88-4a1c0e2f5d6b";
const currentDocumentId = "0198f4c1-2b3d-7a41-9c88-4a1c0e2f5d6c";
const decisionContext = {
  court: "Nejvyšší soud",
  caseNumber: "25 Cdo 627/2022",
  appliedDocumentId,
};
const validity = {
  expression: {
    expressionKind: "consolidation",
    windowDisposition: "effective",
  },
  status: "historical",
  validFrom: "2023-01-06",
  validTo: "2024-01-01",
} as const;

afterEach(cleanup);
afterAll(async () => GlobalRegistrator.unregister());

test("an applied version names its decision and switches to current wording through a focusable action", () => {
  const selected: string[] = [];
  const screen = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <ProvisionVersionContext
          {...validity}
          decisionContext={decisionContext}
          documentId={appliedDocumentId}
          currentVersionId={currentDocumentId}
          onVersionChange={(id) => {
            selected.push(id);
          }}
        />
      </FormattingProvider>
    </IntlProvider>,
  );
  expect(screen.container.textContent).toContain(
    "Version applied in Nejvyšší soud 25 Cdo 627/2022 (Jan 6, 2023 – Dec 31, 2023) · Superseded",
  );
  const action = screen.getByRole("button", {
    name: messages.statutes.currentWording,
  });
  action.focus();
  expect(document.activeElement).toBe(action);
  fireEvent.click(action);
  expect(selected).toEqual([currentDocumentId]);
});

test("the applied current version keeps its decision attribution without a current wording action", () => {
  const screen = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <ProvisionVersionContext
          {...validity}
          status="current"
          validFrom="2024-01-01"
          validTo={null}
          decisionContext={{
            ...decisionContext,
            appliedDocumentId: currentDocumentId,
          }}
          documentId={currentDocumentId}
          currentVersionId={currentDocumentId}
          onVersionChange={() => undefined}
        />
      </FormattingProvider>
    </IntlProvider>,
  );

  expect(screen.container.textContent).toContain(
    "Version applied in Nejvyšší soud 25 Cdo 627/2022",
  );
  expect(screen.container.textContent).toContain(
    messages.statutes.status.current,
  );
  expect(
    screen.queryByRole("button", { name: messages.statutes.currentWording }),
  ).toBeNull();
  expect(screen.container.textContent).not.toContain(
    messages.statutes.currentWording,
  );
});

test("plain views and a different selected version keep the ordinary status label", () => {
  for (const context of [undefined, decisionContext]) {
    const screen = render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <ProvisionVersionContext
            {...validity}
            status="current"
            validFrom="2024-01-01"
            validTo={null}
            decisionContext={context}
            documentId={currentDocumentId}
            currentVersionId={currentDocumentId}
            onVersionChange={() => undefined}
          />
        </FormattingProvider>
      </IntlProvider>,
    );
    expect(screen.container.textContent).toContain(
      messages.statutes.status.current,
    );
    expect(screen.container.textContent).not.toContain(
      decisionContext.caseNumber,
    );
    expect(
      screen.queryByRole("button", { name: messages.statutes.currentWording }),
    ).toBeNull();
    screen.unmount();
  }
});
