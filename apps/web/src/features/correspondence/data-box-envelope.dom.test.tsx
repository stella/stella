import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { DataBoxEnvelope as Envelope } from "@stll/api-contract/data-box";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });

const { cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const messages = (await import("@/i18n/langs/en.json")).default;
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { DataBoxEnvelope } = await import("./data-box-envelope");

afterEach(cleanup);
afterAll(unregisterDomEnvironment);

const party = (boxId: string, name: string) => ({
  boxId,
  name,
  address: null,
  referenceNumber: null,
  fileMark: null,
});

const envelope: Envelope = {
  messageId: "1234567890",
  messageType: "V",
  sender: party("abc2def", "Sender office"),
  recipient: party("xyz9876", "Recipient court"),
  toHands: null,
  personalDelivery: null,
  substituteDelivery: null,
  deliveredAt: null,
  acceptedAt: null,
  status: "delivered",
  seal: {
    status: "unverified",
    signerName: null,
    issuerName: null,
    serialNumber: null,
    signedAt: null,
  },
  directionBasis: "unknown",
};

test("an envelope without contact matches still renders both parties", () => {
  const view = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <DataBoxEnvelope contacts={null} envelope={envelope} />
      </FormattingProvider>
    </IntlProvider>,
  );
  expect(view.getByText("Sender office")).toBeTruthy();
  expect(view.getByText("Recipient court")).toBeTruthy();
  expect(view.getByText("1234567890")).toBeTruthy();
  expect(view.queryAllByRole("link")).toEqual([]);
});

test.each([
  { basis: "organization_sender", label: "Outgoing" },
  { basis: "organization_recipient", label: null },
  { basis: "unknown", label: null },
] as const)(
  "states the direction only when the boxes tell it ($basis)",
  ({ basis, label }) => {
    const view = render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <DataBoxEnvelope
            contacts={null}
            envelope={{ ...envelope, directionBasis: basis }}
          />
        </FormattingProvider>
      </IntlProvider>,
    );
    const heading = view.getByRole("heading", {
      name: messages.correspondence.dataBox.statedInFile,
    });
    // The heading's block holds the direction line when there is one.
    const lines = [...(heading.parentElement?.querySelectorAll("p") ?? [])];
    expect(lines.map((line) => line.textContent)).toEqual(
      label === null ? [] : [label],
    );
  },
);
