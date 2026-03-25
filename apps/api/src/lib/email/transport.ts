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
};

export type EmailTransport = {
  send: (message: EmailMessage) => Promise<void>;
};
