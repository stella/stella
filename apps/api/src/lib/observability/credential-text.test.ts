import { expect, test } from "bun:test";

import {
  sanitizeCredentialText,
  sanitizeFeedbackSecrets,
} from "./credential-text";

test("removes echoed credentials and keeps the full surrounding diagnostic", () => {
  const diagnostic = `${"Provider: ".repeat(
    100,
  )}key=fixture-key denied; please check configuration`;
  expect(sanitizeCredentialText(diagnostic, ["fixture-key"]).text).toBe(
    diagnostic.replace("fixture-key", "[redacted-secret]"),
  );
});

test("redacts recognized credential shapes without truncating text", () => {
  for (const key of [
    "sk-ant-usr-fixture",
    "sk-or-v1-fixture",
    "AIzaFixture",
    "hf_fixture",
  ]) {
    expect(
      sanitizeCredentialText(`Provider rejected ${key}; next step`).text,
    ).toBe("Provider rejected [redacted-secret]; next step");
  }
  expect(sanitizeCredentialText("Bearer fixture-token denied").text).toBe(
    "Bearer [redacted-secret] denied",
  );
});

test("keeps punctuation and noncredential provider identifiers", () => {
  expect(
    sanitizeCredentialText("Provider rejected Bearer fixture-key; retry.", [
      "fixture-key",
    ]).text,
  ).toBe("Provider rejected Bearer [redacted-secret]; retry.");
  expect(sanitizeCredentialText("Bearer fixture-token. Retry.").text).toBe(
    "Bearer [redacted-secret]. Retry.",
  );
  const identifier = "a".repeat(45);
  expect(sanitizeCredentialText(`Project ${identifier} denied`).text).toBe(
    `Project ${identifier} denied`,
  );
  expect(sanitizeFeedbackSecrets(`Project ${identifier} denied`).text).toBe(
    "Project [redacted-secret] denied",
  );
});

test("redacts masked key fragments a provider echoes and credentials in URLs", () => {
  expect(
    sanitizeCredentialText(
      "Incorrect API key provided: sk-proj-****abcd. Also sk-ab…wxyz.",
    ).text,
  ).toBe(
    "Incorrect API key provided: [redacted-secret]. Also [redacted-secret].",
  );
  expect(
    sanitizeCredentialText(
      "Fetching https://fixture-user:fixture-pass@provider.example.test/v1 failed",
    ).text,
  ).toBe("Fetching https://[redacted-secret]@provider.example.test/v1 failed");
  expect(
    sanitizeCredentialText(
      "A task-force reviewed https://provider.example.test",
    ).text,
  ).toBe("A task-force reviewed https://provider.example.test");
});
