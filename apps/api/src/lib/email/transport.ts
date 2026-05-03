/**
 * Provider-agnostic email transport interface.
 *
 * Implementations wrap a specific delivery mechanism
 * (AWS SES, SMTP, etc.) behind a uniform API so the rest
 * of the codebase never couples to a vendor SDK.
 */
export type EmailMessage = {
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
};

export type EmailTransport = {
  send: (message: EmailMessage) => Promise<void>;
};
