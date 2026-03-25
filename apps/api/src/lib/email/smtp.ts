import { createTransport } from "nodemailer";

import type { EmailTransport } from "@/api/lib/email/transport";

export type SMTPTransportConfig = {
  host: string;
  port: number;
  /** Omit for unauthenticated relays (e.g. MailHog in dev). */
  username?: string;
  password?: string;
  /**
   * Require TLS (STARTTLS on 587, implicit on 465).
   * When true, nodemailer will fail instead of falling
   * back to plaintext. Defaults to false for dev relays.
   */
  requireTLS?: boolean;
};

export const createSMTPTransport = (
  config: SMTPTransportConfig,
): EmailTransport => {
  if (
    (config.username && !config.password) ||
    (!config.username && config.password)
  ) {
    throw new Error(
      "Both SMTP_USERNAME and SMTP_PASSWORD must be set (or both omitted)",
    );
  }

  const hasAuth = config.username && config.password;
  const implicitTLS = config.port === 465;

  const transporter = createTransport({
    host: config.host,
    port: config.port,
    secure: implicitTLS,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
    ...(!implicitTLS && config.requireTLS && { requireTLS: true }),
    ...(hasAuth && {
      auth: {
        user: config.username,
        pass: config.password,
      },
    }),
  });

  return {
    async send({ from, to, subject, html }) {
      await transporter.sendMail({ from, to, subject, html });
    },
  };
};
