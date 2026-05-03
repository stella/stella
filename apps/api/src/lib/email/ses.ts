import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

import type { EmailTransport } from "@/api/lib/email/transport";
import { ConfigurationError } from "@/api/lib/errors/tagged-errors";

type SESTransportConfig = {
  region: string;
  /** Omit both to use the SDK default credential chain (IAM roles, env vars, etc.). */
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Optional SES configuration set name to attach to every send. */
  configurationSetName?: string;
};

// eslint-disable-next-line unicorn/text-encoding-identifier-case -- IANA-standard name required by AWS SES API
const SES_CHARSET = "UTF-8";

export const createSESTransport = (
  config: SESTransportConfig,
): EmailTransport => {
  if (
    (config.accessKeyId && !config.secretAccessKey) ||
    (!config.accessKeyId && config.secretAccessKey)
  ) {
    throw new ConfigurationError({
      message:
        "Both SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY must be set (or both omitted)",
    });
  }

  const client = new SESv2Client({
    region: config.region,
    ...(config.accessKeyId &&
      config.secretAccessKey && {
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      }),
    requestHandler: {
      connectionTimeout: 10_000,
      requestTimeout: 10_000,
    },
  });

  return {
    async send({ from, to, subject, html, text }) {
      await client.send(
        new SendEmailCommand({
          FromEmailAddress: from,
          Destination: { ToAddresses: [to] },
          ...(config.configurationSetName && {
            ConfigurationSetName: config.configurationSetName,
          }),
          Content: {
            Simple: {
              Subject: { Data: subject, Charset: SES_CHARSET },
              Body: {
                Html: { Data: html, Charset: SES_CHARSET },
                Text: { Data: text, Charset: SES_CHARSET },
              },
            },
          },
        }),
      );
    },
  };
};
