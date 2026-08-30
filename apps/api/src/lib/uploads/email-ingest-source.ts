export type OutlookEmailSource = {
  mailboxEmail: string;
  sourceId: string;
};

type DeriveOutlookEmailSourceKeyOptions = {
  source: OutlookEmailSource;
};

/**
 * Derive the persisted idempotency key without retaining Outlook identifiers
 * or mailbox addresses. A structured JSON tuple avoids ambiguous concatenation.
 */
export const deriveOutlookEmailSourceKey = ({
  source,
}: DeriveOutlookEmailSourceKeyOptions): string => {
  const mailboxEmail = source.mailboxEmail.trim().toLowerCase();
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify([mailboxEmail, source.sourceId]))
    .digest("hex");
};

export const OUTLOOK_EMAIL_EXTERNAL_SOURCE = "outlook_email";
