import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { load } from "cheerio";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import { formatTransactionalEmailFrom } from "@/api/lib/email/from";

import {
  InboundMessageError,
  parseInboundMessage,
  parseOneMailbox,
} from "./message";

const mailbox = fc
  .tuple(
    fc.stringMatching(/^[a-zA-Z0-9]{1,24}$/u),
    fc.stringMatching(/^[a-zA-Z0-9]{1,24}$/u),
  )
  .map(([local, domain]) => `${local}@${domain}.test`);
const input = fc.oneof(
  fc.uint8Array({ maxLength: 4096 }),
  fc
    .tuple(mailbox, fc.string({ maxLength: 2048 }))
    .map(([sender, body]) =>
      new TextEncoder().encode(
        `From: ${sender}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${body}`,
      ),
    ),
  fc
    .constantFrom(
      "From: one@example.test\r\nFrom: two@example.test\r\n\r\nbody",
      'From: one@example.test\r\nContent-Type: multipart/mixed; boundary="x"\r\n\r\n--x\r\nContent-Type: text/html\r\n\r\n<p onclick="test()">text</p><script>test()</script>\r\n--x--',
    )
    .map((raw) => new TextEncoder().encode(raw)),
);

describe("inbound message properties", () => {
  test(
    "formatted mailboxes round trip with canonical case",
    () => {
      fc.assert(
        fc.property(mailbox, (address) => {
          expect(parseOneMailbox(formatTransactionalEmailFrom(address))).toBe(
            address.toLowerCase(),
          );
          const parsed = parseOneMailbox(address);
          expect(parsed).toBe(address.toLowerCase());
          expect(parseOneMailbox(parsed ?? "")).toBe(parsed);
        }),
        propertyConfig({ seed: propertySeed() }),
      );
    },
    propertyTestTimeout(5000),
  );

  test(
    "arbitrary address headers produce canonical single mailboxes",
    () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 2048 }), (header) => {
          const result = Result.try({
            try: () => parseOneMailbox(header),
            catch: (error) => error,
          });
          expect(result.isOk()).toBe(true);
          if (result.isErr() || result.value === null) {
            return;
          }
          expect(result.value).toBe(result.value.trim().toLowerCase());
          expect(result.value).not.toMatch(/[\s<>;,]/u);
          expect(result.value.split("@")).toHaveLength(2);
          expect(parseOneMailbox(result.value)).toBe(result.value);
        }),
        propertyConfig({ seed: propertySeed() }),
      );
    },
    propertyTestTimeout(5000),
  );

  test(
    "hostile MIME produces typed failures or sanitized messages within budget",
    async () => {
      await fc.assert(
        fc.asyncProperty(input, async (raw) => {
          const start = performance.now();
          const result = await parseInboundMessage(raw);
          expect(performance.now() - start).toBeLessThan(2000);
          if (result.isErr()) {
            expect(result.error).toBeInstanceOf(InboundMessageError);
            return;
          }
          expect(result.value.message.contentHash).toMatch(/^[a-f0-9]{64}$/u);
          const $ = load(result.value.message.html ?? "");
          expect($("script").length).toBe(0);
          if (result.value.forwardSource === "none") {
            expect(result.value.message.from).toBe(result.value.outerSender);
          }
        }),
        propertyConfig({ seed: propertySeed(), numRuns: 50 }),
      );
    },
    propertyTestTimeout(15_000),
  );
});
