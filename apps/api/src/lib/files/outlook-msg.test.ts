import { describe, expect, test } from "bun:test";

import { buildCompoundFile } from "./compound-file.test-fixture";
import {
  parsedEmailToText,
  parseEmail,
  renderEmailHtml,
} from "./email-to-html";
import { parseOutlookMsg } from "./outlook-msg";
import {
  buildOutlookMessage,
  fileTimeProperty,
  int32,
  rootProperty,
  storageProperty,
  toArrayBuffer,
  utf16Property,
} from "./outlook-msg.test-fixture";

const SECTOR_SIZE = 512;

// 1x1 transparent PNG.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
  "base64",
);

describe("parseOutlookMsg", () => {
  test("rejects unsupported CFB sector sizes before reading chains", () => {
    const file = new Uint8Array(SECTOR_SIZE);
    const view = new DataView(file.buffer);
    file.set(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    view.setUint16(30, 15, true);
    view.setUint16(32, 6, true);

    expect(() => parseOutlookMsg(toArrayBuffer(file))).toThrow(
      "unsupported CFB sector size",
    );
  });

  test("reads common message, recipient, and inline attachment properties", async () => {
    const file = buildCompoundFile([
      rootProperty("0037", "001f", utf16Property("Contract draft")),
      rootProperty("0c1a", "001f", utf16Property("Jane Lawyer")),
      rootProperty("5d01", "001f", utf16Property("jane@example.com")),
      rootProperty("0e06", "0040", fileTimeProperty("2026-06-02T10:00:00Z")),
      rootProperty(
        "1013",
        "001f",
        utf16Property(
          '<p>Hello <b>world</b></p><img src="cid:logo"><img src="cid:generic-logo">',
        ),
      ),
      storageProperty("__recip_version1.0_00000000", "0c15", "0003", int32(1)),
      storageProperty(
        "__recip_version1.0_00000000",
        "3001",
        "001f",
        utf16Property("Client One"),
      ),
      storageProperty(
        "__recip_version1.0_00000000",
        "39fe",
        "001f",
        utf16Property("client@example.org"),
      ),
      storageProperty("__recip_version1.0_00000001", "0c15", "0003", int32(2)),
      storageProperty(
        "__recip_version1.0_00000001",
        "3003",
        "001f",
        utf16Property("copy@example.org"),
      ),
      storageProperty("__recip_version1.0_00000002", "0c15", "0003", int32(3)),
      storageProperty(
        "__recip_version1.0_00000002",
        "3003",
        "001f",
        utf16Property("blind@example.org"),
      ),
      storageProperty(
        "__attach_version1.0_00000000",
        "3712",
        "001f",
        utf16Property("logo"),
      ),
      storageProperty(
        "__attach_version1.0_00000000",
        "370e",
        "001f",
        utf16Property("image/png"),
      ),
      storageProperty(
        "__attach_version1.0_00000000",
        "3707",
        "001f",
        utf16Property("logo.png"),
      ),
      storageProperty(
        "__attach_version1.0_00000000",
        "3701",
        "0102",
        PNG_BYTES,
      ),
      storageProperty(
        "__attach_version1.0_00000001",
        "3712",
        "001f",
        utf16Property("generic-logo"),
      ),
      storageProperty(
        "__attach_version1.0_00000001",
        "370e",
        "001f",
        utf16Property("application/octet-stream"),
      ),
      storageProperty(
        "__attach_version1.0_00000001",
        "3707",
        "001f",
        utf16Property("generic-logo.png"),
      ),
      storageProperty(
        "__attach_version1.0_00000001",
        "3701",
        "0102",
        PNG_BYTES,
      ),
    ]);

    const message = parseOutlookMsg(toArrayBuffer(file));

    expect(message.subject).toBe("Contract draft");
    expect(message.fromName).toBe("Jane Lawyer");
    expect(message.fromEmail).toBe("jane@example.com");
    expect(message.date).toBe("Tue, 02 Jun 2026 10:00:00 GMT");
    expect(message.html).toContain("Hello <b>world</b>");
    expect(message.to).toEqual([
      { name: "Client One", email: "client@example.org", type: "to" },
    ]);
    expect(message.cc).toEqual([
      { name: null, email: "copy@example.org", type: "cc" },
    ]);
    expect(message.bcc).toEqual([
      { name: null, email: "blind@example.org", type: "bcc" },
    ]);
    expect(message.attachments).toHaveLength(2);
    expect(message.attachments.at(0)).toMatchObject({
      contentId: "logo",
      fileName: "logo.png",
      mimeType: "image/png",
    });
    expect(message.attachments.at(0)?.bytes).toEqual(PNG_BYTES);
    expect(message.attachments.at(1)).toMatchObject({
      contentId: "generic-logo",
      fileName: "generic-logo.png",
      mimeType: "application/octet-stream",
    });

    const parsedEmail = (
      await parseEmail(toArrayBuffer(file), "application/vnd.ms-outlook")
    ).unwrap();
    const text = parsedEmailToText(parsedEmail);
    expect(text).toContain("From: Jane Lawyer <jane@example.com>");
    expect(text).toContain("To: Client One <client@example.org>");
    expect(text).toContain("Bcc: blind@example.org");
    expect(text).toContain("Subject: Contract draft");
    expect(text).toContain("Hello world");

    const html = renderEmailHtml(parsedEmail);
    expect(html).toContain("data:image/png;base64");
    expect(html).not.toContain("cid:generic-logo");
  });

  test("reads the internet message identity and the submit time", () => {
    const message = parseOutlookMsg(
      buildOutlookMessage({
        subject: "Re: Settlement",
        fromEmail: "counsel@example.org",
        submittedAt: "2026-06-02T09:30:00Z",
        messageId: "<reply@example.org>",
        inReplyTo: "<offer@example.com>",
        references: "<thread@example.com> <offer@example.com>",
        text: "Agreed.",
      }),
    );

    expect(message.messageId).toBe("<reply@example.org>");
    expect(message.inReplyTo).toBe("<offer@example.com>");
    expect(message.references).toBe("<thread@example.com> <offer@example.com>");
    expect(message.submittedAt).toBe("Tue, 02 Jun 2026 09:30:00 GMT");
    // Without a delivery time the display date falls back to the submit time.
    expect(message.date).toBe("Tue, 02 Jun 2026 09:30:00 GMT");
  });
});
