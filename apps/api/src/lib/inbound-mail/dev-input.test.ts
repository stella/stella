import { describe, expect, test } from "bun:test";

import {
  InboundDevInputError,
  parseInboundDevInput,
} from "@/api/lib/inbound-mail/dev-input";

const validArgs = [
  "--file",
  "/tmp/message.eml",
  "--mail-from",
  "sender@example.net",
  "--rcpt-to",
  "one@inbound.example.org",
  "--remote-ip",
  "192.0.2.12",
  "--helo",
  "mx.example.net",
  "--inbound-domain",
  "inbound.example.org",
  "--virus-verdict",
  "pass",
];

describe("development inbound mail arguments", () => {
  test("preserves the required envelope and accepts repeated recipients", () => {
    const result = parseInboundDevInput([
      ...validArgs,
      "--rcpt-to",
      "two@inbound.example.org",
    ]);

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      throw result.error;
    }
    expect(result.value).toEqual({
      file: "/tmp/message.eml",
      inboundDomain: "inbound.example.org",
      scan: "pass",
      envelope: {
        mailFrom: "sender@example.net",
        recipients: ["one@inbound.example.org", "two@inbound.example.org"],
        remoteIp: "192.0.2.12",
        helo: "mx.example.net",
      },
    });
  });

  test.each([
    ["malformed IP", "--remote-ip", "192.0.2.999"],
    ["non-domain inbound host", "--inbound-domain", "example..org"],
    ["unsupported virus verdict", "--virus-verdict", "maybe"],
  ])("rejects %s", (_label, option, value) => {
    const args = [...validArgs];
    const optionIndex = args.indexOf(option);
    args[optionIndex + 1] = value;

    const result = parseInboundDevInput(args);

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      throw new Error("Expected invalid input to be rejected");
    }
    expect(result.error).toBeInstanceOf(InboundDevInputError);
    expect(result.error.message).toContain("Missing or invalid");
  });

  test("rejects a missing required envelope field", () => {
    const args = validArgs.filter((_, index) => index < 6 || index > 7);
    const result = parseInboundDevInput(args);

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      throw new Error("Expected incomplete input to be rejected");
    }
    expect(result.error.message).toContain("Missing or invalid");
  });

  test("rejects unknown options at the argument boundary", () => {
    const result = parseInboundDevInput([...validArgs, "--trust-me"]);

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      throw new Error("Expected unknown option to be rejected");
    }
    expect(result.error).toBeInstanceOf(InboundDevInputError);
    expect(result.error.message).toBe("Invalid inbound ingest arguments");
  });
});
