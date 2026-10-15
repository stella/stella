import { describe, expect, test } from "bun:test";

import type { OutboundEmailPreview } from "@stll/api-contract/outbound-action";

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
