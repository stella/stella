import { describe, expect, test } from "bun:test";

import { isEmailTransportConfigComplete } from "./config";

const baseConfig = {
  emailProvider: "smtp" as const,
  sesAccessKeyId: undefined,
  sesRegion: undefined,
  sesSecretAccessKey: undefined,
  smtpHost: "localhost",
  smtpPassword: undefined,
  smtpPort: 1025,
  smtpUsername: undefined,
  transactionalEmailFrom: "stella@example.com",
};

describe("email transport configuration", () => {
  test("accepts SMTP without credentials or with a complete credential pair", () => {
    expect(isEmailTransportConfigComplete(baseConfig)).toBe(true);
    expect(
      isEmailTransportConfigComplete({
        ...baseConfig,
        smtpUsername: "user",
        smtpPassword: "pass",
      }),
    ).toBe(true);
  });

  test("rejects partial SMTP credentials", () => {
    expect(
      isEmailTransportConfigComplete({
        ...baseConfig,
        smtpUsername: "user",
      }),
    ).toBe(false);
    expect(
      isEmailTransportConfigComplete({
        ...baseConfig,
        smtpPassword: "pass",
      }),
    ).toBe(false);
  });

  test("rejects partial SES credentials", () => {
    const sesConfig = {
      ...baseConfig,
      emailProvider: "ses" as const,
      sesRegion: "eu-central-1",
      smtpHost: undefined,
      smtpPort: undefined,
    };

    expect(isEmailTransportConfigComplete(sesConfig)).toBe(true);
    expect(
      isEmailTransportConfigComplete({
        ...sesConfig,
        sesAccessKeyId: "access",
      }),
    ).toBe(false);
    expect(
      isEmailTransportConfigComplete({
        ...sesConfig,
        sesSecretAccessKey: "secret",
      }),
    ).toBe(false);
    expect(
      isEmailTransportConfigComplete({
        ...sesConfig,
        sesAccessKeyId: "access",
        sesSecretAccessKey: "secret",
      }),
    ).toBe(true);
  });
});
