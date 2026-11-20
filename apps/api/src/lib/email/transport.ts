/**
 * Provider-agnostic email transport interface.
 *
 * Implementations wrap a specific delivery mechanism
 * (AWS SES, SMTP, etc.) behind a uniform API so the rest
 * of the codebase never couples to a vendor SDK.
 */
type EmailMessage = {
  from: string;
  to: string;
  subject: string;
  html: string;
  /**
   * Plain-text alternative. Required: HTML-only mail is a known
   * spam signal at Gmail and Outlook, and accessibility tooling
   * (screen readers, text-only clients) needs the text part.
   */
  text: string;
  /** Where replies go when the sender address is the platform's own. */
  replyTo?: string;
  /**
   * Images the HTML shows through `cid:` references, sent as inline parts of
   * the message so the mail client fetches nothing to display them.
   */
  inlineImages?: readonly InlineImage[];
};

export type InlineImage = {
  /** The id the HTML references as `cid:<contentId>`. */
  contentId: string;
  filename: string;
  contentType: string;
  content: Uint8Array;
};

export type EmailTransport = {
  send: (message: EmailMessage) => Promise<void>;
};
