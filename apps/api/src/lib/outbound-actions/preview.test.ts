import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { outboundActionPreviewSchema } from "@stll/api-contract/outbound-action";
import type { OutboundEmailPreview } from "@stll/api-contract/outbound-action";
import { assertProperty } from "@stll/property-testing";

import { outboundPreviewHash } from "@/api/lib/outbound-actions/preview";

const preview: OutboundEmailPreview = {
  kind: "email.send",
  from: { address: "lawyer@example.test", name: "Lawyer" },
  to: [{ address: "client@example.test" }],
  cc: [],
  bcc: [],
  subject: "Draft agreement",
  bodyText: "Please find the draft attached.",
  attachments: [
    { fileName: "draft.docx", byteLength: 1024, sha256: "a".repeat(64) },
  ],
  inReplyTo: null,
};

describe("outboundPreviewHash", () => {
  test("is stable across key order", () => {
    const reordered: OutboundEmailPreview = {
      inReplyTo: null,
      attachments: preview.attachments,
      bodyText: preview.bodyText,
      subject: preview.subject,
      bcc: [],
      cc: [],
      to: preview.to,
      from: { name: "Lawyer", address: "lawyer@example.test" },
      kind: "email.send",
    };
    expect(outboundPreviewHash(reordered)).toBe(outboundPreviewHash(preview));
    expect(outboundPreviewHash(preview)).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("changes when anything the user is shown changes", () => {
    const base = outboundPreviewHash(preview);
    const variants: OutboundEmailPreview[] = [
      { ...preview, to: [{ address: "other@example.test" }] },
      { ...preview, bcc: [{ address: "hidden@example.test" }] },
      { ...preview, subject: "Draft agreement (v2)" },
      { ...preview, bodyText: `${preview.bodyText} ` },
      {
        ...preview,
        attachments: [
          { fileName: "draft.docx", byteLength: 1024, sha256: "b".repeat(64) },
        ],
      },
      { ...preview, inReplyTo: "<message@example.test>" },
      { ...preview, from: { address: "lawyer@example.test" } },
    ];
    for (const variant of variants) {
      expect(outboundPreviewHash(variant)).not.toBe(base);
    }
  });
});

describe("outbound email header fields", () => {
  // Every field an executor writes into a header value.
  const withHeaderText = {
    fromName: (text: string) => ({
      ...preview,
      from: { ...preview.from, name: text },
    }),
    toName: (text: string) => ({
      ...preview,
      to: [{ address: "client@example.test", name: text }],
    }),
    bccName: (text: string) => ({
      ...preview,
      bcc: [{ address: "hidden@example.test", name: text }],
    }),
    subject: (text: string) => ({ ...preview, subject: text }),
    inReplyTo: (text: string) => ({ ...preview, inReplyTo: `<${text}>` }),
    attachmentName: (text: string) => ({
      ...preview,
      attachments: [
        { fileName: `${text}.docx`, byteLength: 1024, sha256: "a".repeat(64) },
      ],
    }),
  } as const;
  const parses = (value: unknown) =>
    v.safeParse(outboundActionPreviewSchema, value).success;

  test("a line break in any header field is rejected; the same text without one is kept", () => {
    assertProperty(
      "a line break in any header field is rejected; the same text without one is kept",
      fc.property(
        fc.constantFrom(...Object.values(withHeaderText)),
        fc.stringMatching(/^[^\r\n]{1,40}$/u),
        fc.constantFrom("\r\n", "\n", "\r"),
        fc.nat({ max: 40 }),
        (build, text, lineBreak, at) => {
          const cut = Math.min(at, text.length);
          const injected = `${text.slice(0, cut)}${lineBreak}Bcc: x@example.test${text.slice(cut)}`;
          expect(parses(build(text))).toBe(true);
          expect(parses(build(injected))).toBe(false);
        },
      ),
    );
  });
});
