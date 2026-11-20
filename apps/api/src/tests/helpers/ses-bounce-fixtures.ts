/**
 * A configuration-set Bounce event as the mail provider publishes it when a
 * recipient server offers no STARTTLS and the configuration set requires TLS:
 * a transient bounce whose recipient status names a missing mailbox (5.1.1)
 * while the diagnostic says why. Addresses and ids are placeholders.
 */
export const STARTTLS_REFUSAL_BOUNCE = {
  eventType: "Bounce",
  bounce: {
    feedbackId: "0102019a3f2b7c1e-5d6a4b2c-8e1f-4a3b-9c7d-2e5f6a7b8c9d-000000",
    bounceType: "Transient",
    bounceSubType: "General",
    bouncedRecipients: [
      {
        emailAddress: "New.Member@example.test",
        action: "failed",
        status: "5.1.1",
        diagnosticCode:
          "smtp; 550 5.1.1 Remote MTA does not support STARTTLS. Message can be delivered only over a TLS connection.",
      },
    ],
    timestamp: "2026-11-20T08:14:03.512Z",
    reportingMTA: "dns; a1-23.smtp-out.eu-west-1.amazonses.com",
  },
  mail: {
    timestamp: "2026-11-20T08:14:02.981Z",
    source: "stella <no-reply@mail.example.test>",
    sendingAccountId: "123456789012",
    messageId: "0102019a3f2b7a61-provider-message-000000",
    destination: ["New.Member@example.test"],
    tags: { "ses:configuration-set": ["transactional"] },
  },
} as const;
