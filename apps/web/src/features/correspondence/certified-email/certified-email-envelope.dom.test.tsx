import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

import type { CertifiedEmailEnvelope as Envelope } from "@stll/api-contract/certified-email";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import messages from "@/i18n/langs/en.json";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { act, cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { CertifiedEmailEnvelope } = await import("./certified-email-envelope");
const { certifiedEmailCatalog } = await import("./certified-email-catalog");

beforeAll(async () => {
  // The envelope's strings load with its chunk; start the load and wait for
  // the same module, so a render only has to settle the resolved catalog.
  certifiedEmailCatalog.preload("en");
  await import("./i18n/langs/en.json");
});

afterEach(() => {
  cleanup();
});
afterAll(async () => await unregisterDomEnvironment());

const NOTICE = {
  system: "pec",
  kind: "delivery_error",
  error: "no_recipient",
  errorDetail: "5.1.1 Utente non riconosciuto",
  sender: "mittente@pec.example.com",
  recipients: [
    { address: "destinatario@pec.example.com", certified: true },
    { address: "ufficio@example.org", certified: false },
    { address: "ufficio@example.org", certified: false },
  ],
  replyTo: null,
  subject: "Notifica",
  provider: "Example PEC provider",
  certifiedAt: "2026-11-21T09:15:30.000Z",
  messageId: "opec-fixture@pec.example.com",
  originalMessageId: null,
  receiptType: null,
  deliveredTo: "destinatario@pec.example.com",
  receivedFor: [],
  includesOriginal: false,
  signature: {
    status: "unverified",
    signerName: "Example signer",
    issuerName: null,
    serialNumber: null,
    signedAt: null,
  },
} as const satisfies Envelope;

const renderEnvelope = async (envelope: Envelope) => {
  let view: ReturnType<typeof render> | undefined;
  // React retries the suspended tree inside act once the catalog settles.
  await act(async () => {
    view = render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <CertifiedEmailEnvelope envelope={envelope} />
        </FormattingProvider>
      </IntlProvider>,
    );
    await Promise.resolve();
  });
  return view?.container.textContent ?? "";
};

test("a non-delivery notice states its outcome, error and unverified signature", async () => {
  const text = await renderEnvelope(NOTICE);
  for (const expected of [
    "Non-delivery notice (PEC)",
    "As stated in the file",
    "This file does not include the original message.",
    "Not delivered to",
    "Unknown recipient",
    "5.1.1 Utente non riconosciuto",
    "Example PEC provider",
    "Signed by Example signer",
    "The provider’s signature is kept with the file and not verified.",
  ]) {
    expect(text).toContain(expected);
  }
  // Each ordinary mailbox is marked, repeated addresses included.
  expect(text.split("Ordinary mailbox")).toHaveLength(3);
});

test("a transport envelope with its original names no error or delivery", async () => {
  const text = await renderEnvelope({
    ...NOTICE,
    kind: "transport",
    error: "none",
    errorDetail: null,
    deliveredTo: null,
    receiptType: "short",
    includesOriginal: true,
    signature: { ...NOTICE.signature, signerName: null },
  });
  expect(text).toContain("Certified email (PEC)");
  expect(text).toContain("Short receipt");
  expect(text).not.toContain("original message");
  expect(text).not.toContain("Reported error");
  expect(text).not.toContain("delivered to");
  expect(text).not.toContain("Signed by");
  expect(text).toContain(
    "The provider’s signature is kept with the file and not verified.",
  );
});

test("long addresses wrap inside a narrow card instead of running past it", async () => {
  const longAddress =
    "ufficio.contenzioso.civile.tribunale-ordinario@pec.giustizia-example.it";
  await renderEnvelope({
    ...NOTICE,
    recipients: [{ address: longAddress, certified: true }],
    receivedFor: [longAddress],
  });
  const card = document.querySelector('[data-slot="envelope-card"]');
  // Columns follow the card's own width, not the viewport's.
  expect(card?.className).not.toMatch(/(?:^|\s)(?:sm|md|lg):/u);
  const values = [
    ...document.querySelectorAll('[data-slot="envelope-field-value"]'),
  ];
  expect(values.length).toBeGreaterThan(3);
  for (const value of values) {
    // `anywhere` lowers the value's min-content width, so an unbroken
    // address inside a flex row can narrow; `break-word` would not.
    expect(value.className.split(" ")).toContain("wrap-anywhere");
    expect(value.className).not.toContain("wrap-break-word");
  }
  expect(
    values.some((value) => value.textContent.includes(longAddress)),
  ).toBeTrue();
});
