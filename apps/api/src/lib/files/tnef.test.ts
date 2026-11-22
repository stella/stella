import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  tnefAttribute,
  tnefStream,
  wendlerMessage,
} from "@/api/tests/fixtures/tnef";

import { rtfMessageBody } from "./rtf-body";
import { hasTnefSignature, parseTnef, TNEF_LIMITS } from "./tnef";

const {
  message: WENDLER_MESSAGE,
  draft: DRAFT,
  exhibits: EXHIBITS,
} = await wendlerMessage();

describe("a TNEF stream", () => {
  test("carries its message: subject, sender, recipients, date, bodies", () => {
    const message = parseTnef(tnefStream(WENDLER_MESSAGE)).unwrap();
    expect(message).toMatchObject({
      subject: WENDLER_MESSAGE.subject,
      fromName: "Dr. Katharina Wendler",
      fromEmail: "k.wendler@wendler-rechtsanwaelte.de",
      recipients: [
        {
          name: "Jonas Pfeiffer",
          email: "j.pfeiffer@pfeiffer-hochbau.de",
          type: "to",
        },
        {
          name: "Lea Brandstetter",
          email: "l.brandstetter@wendler-rechtsanwaelte.de",
          type: "cc",
        },
      ],
      date: "Tue, 17 Nov 2026 08:42:00 GMT",
      html: null,
      text: WENDLER_MESSAGE.body.text,
    });
    expect(message.rtf).not.toBeNull();
    expect(message.rtf === null ? null : rtfMessageBody(message.rtf)).toEqual({
      type: "html",
      html: "<html><body><p>Sehr geehrter Herr Pfeiffer,</p><p>anbei der Entwurf der Klageerwiderung für die mündliche Verhandlung am 9. Dezember.</p></body></html>",
    });
  });

  test("carries its attachments under their long names, with their types and bytes", () => {
    const { attachments } = parseTnef(tnefStream(WENDLER_MESSAGE)).unwrap();
    expect(
      attachments.map(({ fileName, mimeType, bytes, message }) => ({
        fileName,
        mimeType,
        size: bytes.byteLength,
        message,
      })),
    ).toEqual([
      {
        fileName: "Klageerwiderung_Entwurf_3_O_214-26.pdf",
        mimeType: "application/pdf",
        size: DRAFT.byteLength,
        message: false,
      },
      {
        fileName: "Anlagenverzeichnis Pfeiffer Hochbau GmbH.txt",
        mimeType: "text/plain",
        size: EXHIBITS.byteLength,
        message: false,
      },
    ]);
    expect(
      Buffer.from(attachments[0]?.bytes ?? []).equals(Buffer.from(DRAFT)),
    ).toBe(true);
  });

  test("an attachment with only the legacy attributes keeps its legacy title", () => {
    const { attachments } = parseTnef(
      tnefStream({
        ...WENDLER_MESSAGE,
        attachments: [
          {
            fileName: "unused",
            title: "VOLLMACH.TXT",
            bytes: new TextEncoder().encode("Vollmacht"),
            legacyOnly: true,
          },
        ],
      }),
    ).unwrap();
    expect(attachments).toEqual([
      expect.objectContaining({ fileName: "VOLLMACH.TXT", mimeType: null }),
    ]);
  });

  test("an attached message is kept whole, as its own TNEF stream, and reads in turn", () => {
    const inner = tnefStream({
      ...WENDLER_MESSAGE,
      subject: "AW: Abnahmeprotokoll Bauabschnitt 2",
      attachments: [WENDLER_MESSAGE.attachments[1]],
    });
    const { attachments } = parseTnef(
      tnefStream({
        ...WENDLER_MESSAGE,
        attachments: [],
        attachedMessage: {
          name: "AW: Abnahmeprotokoll Bauabschnitt 2",
          tnef: inner,
        },
      }),
    ).unwrap();
    expect(attachments).toEqual([
      expect.objectContaining({
        fileName: "AW: Abnahmeprotokoll Bauabschnitt 2",
        message: true,
      }),
    ]);
    const attached = attachments[0]?.bytes ?? new Uint8Array();
    expect(hasTnefSignature(attached)).toBe(true);
    expect(
      parseTnef(attached)
        .unwrap()
        .attachments.map(({ fileName }) => fileName),
    ).toEqual(["Anlagenverzeichnis Pfeiffer Hochbau GmbH.txt"]);
  });

  test("a hidden image of the body is marked hidden, with its content ID", () => {
    const { attachments } = parseTnef(
      tnefStream({
        ...WENDLER_MESSAGE,
        attachments: [
          {
            fileName: "image001.png",
            mimeType: "image/png",
            contentId: "image001.png@01DB3A1C.5E2F0B40",
            hidden: true,
            bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          },
          { ...WENDLER_MESSAGE.attachments[1], hidden: false },
        ],
      }),
    ).unwrap();
    expect(
      attachments.map(({ hidden, contentId }) => [hidden, contentId]),
    ).toEqual([
      [true, "image001.png@01DB3A1C.5E2F0B40"],
      [false, null],
    ]);
  });

  test("refuses what is not a TNEF stream, or is cut short", () => {
    expect(parseTnef(new TextEncoder().encode("%PDF-1.7")).isErr()).toBe(true);
    const stream = tnefStream(WENDLER_MESSAGE);
    for (const cut of [7, 20, stream.byteLength - 1]) {
      const read = parseTnef(stream.subarray(0, cut));
      expect({ cut, failed: read.isErr() }).toEqual({ cut, failed: true });
    }
  });

  test("refuses counts past their bounds before reading them", () => {
    const header = new Uint8Array([0x78, 0x9f, 0x3e, 0x22, 0x00, 0x01]);
    const tooManyProperties = new Uint8Array(
      Buffer.concat([
        header,
        tnefAttribute(
          1,
          0x00_06_90_03,
          new Uint8Array(
            Buffer.concat([
              new Uint8Array(
                new Uint32Array([TNEF_LIMITS.propertiesPerList + 1]).buffer,
              ),
            ]),
          ),
        ),
      ]),
    );
    const read = parseTnef(tooManyProperties);
    expect(read.isErr() && read.error.reason).toBe("limit");

    const rendering = tnefAttribute(2, 0x00_06_90_02, new Uint8Array(14));
    const tooManyAttachments = new Uint8Array(
      Buffer.concat([
        header,
        ...Array.from({ length: TNEF_LIMITS.attachments + 1 }, () => rendering),
      ]),
    );
    const attachments = parseTnef(tooManyAttachments);
    expect(attachments.isErr() && attachments.error.reason).toBe("limit");

    // A multi-valued string with more values than a property may hold.
    const manyValues = new Uint8Array(
      Buffer.concat([
        new Uint8Array(new Uint32Array([1]).buffer),
        new Uint8Array(new Uint16Array([0x10_1f, 0x0e_1d]).buffer),
        new Uint8Array(
          new Uint32Array([TNEF_LIMITS.valuesPerProperty + 1]).buffer,
        ),
      ]),
    );
    const values = parseTnef(
      new Uint8Array(
        Buffer.concat([header, tnefAttribute(1, 0x00_06_90_03, manyValues)]),
      ),
    );
    expect(values.isErr() && values.error.reason).toBe("limit");
  });

  test("any attachments read back as written", () => {
    assertProperty(
      "any attachments read back as written",
      fc.property(
        fc.array(
          fc.record({
            fileName: fc
              .string({ minLength: 1, maxLength: 40 })
              .filter((name) => name.replaceAll("\u0000", "").trim() === name),
            bytes: fc.uint8Array({ maxLength: 300 }),
            mimeType: fc.constantFrom(
              "application/pdf",
              "text/plain",
              "image/png",
            ),
          }),
          { maxLength: 6 },
        ),
        (files) => {
          const { attachments } = parseTnef(
            tnefStream({ ...WENDLER_MESSAGE, attachments: files }),
          ).unwrap();
          expect(
            attachments.map(({ fileName, mimeType, bytes }) => ({
              fileName,
              mimeType,
              bytes: Array.from(bytes),
            })),
          ).toEqual(
            files.map(({ fileName, mimeType, bytes }) => ({
              fileName,
              mimeType,
              bytes: Array.from(bytes),
            })),
          );
        },
      ),
      { numRuns: 60 },
    );
  });

  test("any change to a stream reads or is refused, never throws", () => {
    const stream = tnefStream(WENDLER_MESSAGE);
    assertProperty(
      "any change to a stream reads or is refused, never throws",
      fc.property(
        fc.array(
          fc.tuple(
            fc.nat(stream.byteLength - 1),
            fc.integer({ min: 0, max: 255 }),
          ),
          {
            minLength: 1,
            maxLength: 8,
          },
        ),
        fc.nat(stream.byteLength),
        (changes, cut) => {
          const changed = stream.slice(0, Math.max(6, cut));
          for (const [at, byte] of changes) {
            if (at >= 6 && at < changed.byteLength) {
              changed[at] = byte;
            }
          }
          const read = parseTnef(changed);
          expect(read.isOk() || read.isErr()).toBe(true);
          if (read.isOk()) {
            expect(read.value.attachments.length).toBeLessThanOrEqual(
              TNEF_LIMITS.attachments,
            );
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
