import { PDF } from "@libpdf/core";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { dataBoxDocumentText } from "@/api/lib/email/correspondence/data-box/document-text";
import {
  DATA_BOX_MESSAGE_LIMITS,
  parseDataBoxDocument,
  parseDataBoxMessage,
} from "@/api/lib/email/correspondence/data-box/zfo";
import {
  FIXTURE_MESSAGE,
  messageXml,
  receiptXml,
  SEAL_COMMON_NAME,
  SEAL_SIGNED_AT,
  sealContent,
  zfoFile,
} from "@/api/tests/fixtures/zfo";

const encode = (text: string) => new TextEncoder().encode(text);

const failureReason = (
  bytes: Uint8Array,
  limits: Parameters<typeof parseDataBoxMessage>[1] = DATA_BOX_MESSAGE_LIMITS,
) => {
  const parsed = parseDataBoxMessage(bytes, limits);
  return parsed.isErr() ? parsed.error.reason : null;
};

describe("parseDataBoxMessage", () => {
  test.each(["0", "00", "11", "99", "-1", "1.5"])(
    "leaves unknown status codes unset: %s",
    async (messageStatus) => {
      const parsed = parseDataBoxMessage(await zfoFile({ messageStatus }));
      if (parsed.isErr()) {
        throw parsed.error;
      }
      expect(parsed.value.envelope.status).toBeNull();
    },
  );

  test("reads the envelope, files and seal of a sealed message", async () => {
    const parsed = parseDataBoxMessage(await zfoFile());
    if (parsed.isErr()) {
      throw parsed.error;
    }
    const { annotation, envelope, files } = parsed.value;
    expect(annotation).toBe(FIXTURE_MESSAGE.annotation);
    expect(envelope).toEqual({
      messageId: "1234567890",
      messageType: "V",
      sender: {
        boxId: "abc2def",
        name: FIXTURE_MESSAGE.senderName,
        address: "Testovací 1, 100 00 Testov",
        referenceNumber: "12 C 345/2026-17",
        fileMark: "12 C 345/2026",
      },
      recipient: {
        boxId: "xyz9876",
        name: FIXTURE_MESSAGE.recipientName,
        address: "Příkladná 2, 100 00 Testov",
        referenceNumber: "2026/014",
        fileMark: null,
      },
      toHands: "Mgr. Jana Testová",
      personalDelivery: true,
      substituteDelivery: false,
      deliveredAt: "2026-10-14T07:12:33.120Z",
      acceptedAt: "2026-10-14T08:03:00.000Z",
      status: "accepted_by_login",
      seal: {
        status: "unverified",
        signerName: SEAL_COMMON_NAME,
        issuerName: SEAL_COMMON_NAME,
        serialNumber: expect.stringMatching(/^[0-9a-f]+$/u),
        signedAt: SEAL_SIGNED_AT.toISOString(),
      },
    });
    expect(
      files.map((file) => ({
        fileName: file.fileName,
        mimeType: file.mimeType,
        text: new TextDecoder().decode(file.bytes),
      })),
    ).toEqual(
      FIXTURE_MESSAGE.files.map((file) => ({
        fileName: file.name,
        mimeType: file.mimeType,
        text: new TextDecoder().decode(file.content),
      })),
    );
    for (const file of files) {
      if (file.mimeType === "application/pdf") {
        const pdf = await PDF.load(file.bytes);
        expect(pdf.isEncrypted).toBe(false);
      }
    }
  });

  test("maps acceptance by fiction and leaves unzoned times unknown", async () => {
    const parsed = parseDataBoxMessage(
      await zfoFile({
        messageStatus: "5",
        acceptanceTime: "2026-10-24T09:12:33",
        personalDelivery: "",
        messageType: "lowercase",
      }),
    );
    if (parsed.isErr()) {
      throw parsed.error;
    }
    expect(parsed.value.envelope).toMatchObject({
      status: "accepted_by_fiction",
      acceptedAt: null,
      personalDelivery: null,
      messageType: null,
    });
  });

  test("leaves an impossible stated delivery date unknown", async () => {
    const message = parseDataBoxMessage(
      await zfoFile({ deliveryTime: "2026-02-30T09:12:33+01:00" }),
    ).unwrap();
    expect(message.envelope.deliveredAt).toBeNull();
  });

  test("files a message without files", async () => {
    const parsed = parseDataBoxMessage(await zfoFile({ files: [] }));
    expect(parsed.isOk() && parsed.value.files).toEqual([]);
  });

  test("names an undescribed file and falls back on an invalid media type", async () => {
    const xml = messageXml().replace(
      'dmMimeType="application/pdf" dmFileMetaType="main" dmFileDescr="usneseni.pdf"',
      'dmMimeType="not a type"',
    );
    const parsed = parseDataBoxMessage(await sealContent(encode(xml)));
    if (parsed.isErr()) {
      throw parsed.error;
    }
    expect(parsed.value.files.at(0)).toMatchObject({
      fileName: "attachment-1",
      mimeType: "application/octet-stream",
    });
  });

  test("summarizes the envelope as searchable text", async () => {
    const parsed = parseDataBoxMessage(await zfoFile());
    if (parsed.isErr()) {
      throw parsed.error;
    }
    const text = dataBoxDocumentText(parsed.value);
    for (const expected of [
      FIXTURE_MESSAGE.annotation,
      "abc2def",
      "12 C 345/2026",
      "usneseni.pdf",
      "1234567890",
      "Delivered to data box (dodáno): 2026-10-14T07:12:33.120Z",
      "Accepted (doručeno): 2026-10-14T08:03:00.000Z",
      "File seal: unverified",
    ]) {
      expect(text).toContain(expected);
    }
  });
});

describe("ISDS exports", () => {
  // ISDS tFile allows inline XML. The libisds signed_sent_xml_message
  // fixture also covers legacy fragments with multiple or zero elements.
  // https://deb.debian.org/debian/pool/main/libi/libisds/libisds_0.10.7.orig.tar.gz
  // https://github.com/datagov-cz/isds-adapter/blob/main/src/main/resources/wsdl/dmBaseTypes.xsd#L71-L89
  test("reads inline XML in a sent export alongside binary attachments", async () => {
    const fragments = [
      {
        fileName: "rozhodnuti.xml",
        content: "<doc:decision>§ 1 &amp; § 2</doc:decision>",
        expected:
          '<doc:decision xmlns:doc="urn:test:decision">§ 1 &amp; § 2</doc:decision>',
      },
      {
        fileName: "priloha.xml",
        content: "<first/>text<second/>",
        expected: "<first/>text<second/>",
      },
      { fileName: "prazdny.xml", content: "", expected: "" },
    ];
    const inlineFiles = fragments.map(
      ({ fileName, content }) =>
        `<p:dmFile dmMimeType="application/xml" dmFileDescr="${fileName}"><p:dmXMLContent xmlns:doc="urn:test:decision">${content}</p:dmXMLContent></p:dmFile>`,
    );
    const xml = messageXml()
      .replace("/v20/message", "/v20/SentMessage")
      .replace("</p:dmFiles>", () => `${inlineFiles.join("")}</p:dmFiles>`);
    const result = parseDataBoxMessage(await sealContent(encode(xml))).unwrap();
    expect(result.files.map(({ fileName }) => fileName)).toEqual([
      "usneseni.pdf",
      "pouceni.txt",
      ...fragments.map(({ fileName }) => fileName),
    ]);
    expect(result.files.slice(FIXTURE_MESSAGE.files.length)).toEqual(
      fragments.map(({ fileName, expected }) => ({
        fileName,
        mimeType: "application/xml",
        bytes: encode(expected),
      })),
    );
  });

  test.each(["message", "SentMessage"])(
    "reads the %s export and its attachments",
    async (namespace) => {
      const xml = messageXml().replace(
        "/v20/message",
        () => `/v20/${namespace}`,
      );
      const result = parseDataBoxDocument(
        await sealContent(encode(xml)),
      ).unwrap();
      expect(result.kind).toBe("message");
      expect(dataBoxDocumentText(result)).toContain("Attachment: usneseni.pdf");
    },
  );

  test.each(["czechpoint", "czebox"])(
    "reads a %s delivery receipt in event order",
    async (host) => {
      const xml = receiptXml().replaceAll(
        "isds.czechpoint.cz",
        () => `isds.${host}.cz`,
      );
      const grouped = xml.replace("</q:dmEvent><q:dmEvent>", "");
      for (const variant of [xml, grouped]) {
        const bytes = await sealContent(encode(variant));
        const result = parseDataBoxDocument(bytes).unwrap();
        expect(result).toMatchObject({
          kind: "receipt",
          envelope: {
            messageId: FIXTURE_MESSAGE.messageId,
            seal: { status: "unverified" },
          },
          events: [
            {
              occurredAt: "2026-10-14T07:12:33.120Z",
              description: "EV5: Dodáno.",
            },
            {
              occurredAt: "2026-10-14T08:03:00.000Z",
              description: "EV11: Doručeno přihlášením oprávněné osoby.",
            },
          ],
        });
        expect(dataBoxDocumentText(result)).toContain(
          "EV11: Doručeno přihlášením oprávněné osoby.",
        );
        expect(failureReason(bytes)).toBe("not_a_message");
      }
    },
  );

  test("omits a receipt event that states neither a readable time nor a description", async () => {
    const xml = receiptXml().replace(
      "<q:dmEvents>",
      "<q:dmEvents><q:dmEvent><q:dmEventTime>not a time</q:dmEventTime><q:dmEventTime>2026-10-14 07:00</q:dmEventTime></q:dmEvent><q:dmEvent><q:dmEventDescr> </q:dmEventDescr></q:dmEvent>",
    );
    const result = parseDataBoxDocument(
      await sealContent(encode(xml)),
    ).unwrap();
    expect(result.kind === "receipt" ? result.events : null).toEqual([
      { occurredAt: "2026-10-14T07:12:33.120Z", description: "EV5: Dodáno." },
      {
        occurredAt: "2026-10-14T08:03:00.000Z",
        description: "EV11: Doručeno přihlášením oprávněné osoby.",
      },
    ]);
    expect(dataBoxDocumentText(result)).not.toMatch(/Delivery event: *$/mu);
  });
});

describe("parseDataBoxMessage refusals", () => {
  test("bounds the delivery events a receipt may list", async () => {
    const events = (count: number) =>
      receiptXml().replace(
        /<q:dmEvents>.*<\/q:dmEvents>/u,
        () =>
          `<q:dmEvents>${"<q:dmEvent><q:dmEventDescr>EV0</q:dmEventDescr></q:dmEvent>".repeat(count)}</q:dmEvents>`,
      );
    const read = async (count: number) => {
      const parsed = parseDataBoxDocument(
        await sealContent(encode(events(count))),
      );
      return parsed.isErr() ? parsed.error.reason : parsed.value.kind;
    };
    expect(await read(DATA_BOX_MESSAGE_LIMITS.maxEvents)).toBe("receipt");
    expect(await read(DATA_BOX_MESSAGE_LIMITS.maxEvents + 1)).toBe(
      "too_many_events",
    );
    // A single dmEvent may group pairs; the bound holds inside it too.
    const grouped = receiptXml().replace(
      /<q:dmEvents>.*<\/q:dmEvents>/u,
      () =>
        `<q:dmEvents><q:dmEvent>${"<q:dmEventDescr>EV0</q:dmEventDescr>".repeat(DATA_BOX_MESSAGE_LIMITS.maxEvents + 1)}</q:dmEvent></q:dmEvents>`,
    );
    const parsed = parseDataBoxDocument(await sealContent(encode(grouped)));
    expect(parsed.isErr() ? parsed.error.reason : null).toBe("too_many_events");
  });

  test("refuses bytes that are not DER", () => {
    expect(failureReason(encode("not a signed file"))).toBe("not_signed_data");
    expect(failureReason(new Uint8Array())).toBe("not_signed_data");
  });

  test("refuses unsealed XML", () => {
    expect(failureReason(encode(messageXml()))).toBe("not_signed_data");
  });

  test("refuses truncated DER", async () => {
    const bytes = await zfoFile();
    expect(failureReason(bytes.subarray(0, bytes.length / 2))).toBe(
      "not_signed_data",
    );
  });

  test("refuses a file over the size limit before decoding it", async () => {
    const bytes = await zfoFile();
    expect(
      failureReason(bytes, {
        ...DATA_BOX_MESSAGE_LIMITS,
        maxFileBytes: bytes.byteLength - 1,
      }),
    ).toBe("too_large");
  });

  test("refuses a document type declaration and never expands entities", async () => {
    const xml = messageXml().replace(
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<?xml version="1.0"?><!DOCTYPE q [<!ENTITY x SYSTEM "file:///etc/passwd">]>',
    );
    expect(failureReason(await sealContent(encode(xml)))).toBe("malformed_xml");
  });

  test("refuses malformed XML and non-UTF-8 content", async () => {
    expect(
      failureReason(await sealContent(encode(messageXml().slice(0, 300)))),
    ).toBe("malformed_xml");
    expect(
      failureReason(await sealContent(new Uint8Array([0x3c, 0xff, 0xfe]))),
    ).toBe("malformed_xml");
  });

  test("bounds the markup a parse may build", async () => {
    expect(
      failureReason(await zfoFile(), {
        ...DATA_BOX_MESSAGE_LIMITS,
        maxMarkup: 10,
      }),
    ).toBe("malformed_xml");
  });

  test("refuses XML that is not a message", async () => {
    const delivery = messageXml()
      .replaceAll("q:dmReturnedMessage", "q:dmDelivery")
      .replaceAll("MessageDownloadResponse", "GetDeliveryInfoResponse");
    expect(failureReason(await sealContent(encode(delivery)))).toBe(
      "not_a_message",
    );
    const foreign = messageXml().replaceAll(
      "http://isds.czechpoint.cz/",
      "http://example.test/",
    );
    expect(failureReason(await sealContent(encode(foreign)))).toBe(
      "not_a_message",
    );
  });

  test("refuses an envelope without a valid message or box ID", async () => {
    for (const overrides of [
      { messageId: "" },
      { messageId: "12ab" },
      { senderBoxId: "too-long-id" },
      { recipientBoxId: "" },
    ]) {
      expect(failureReason(await zfoFile(overrides))).toBe("invalid_envelope");
    }
  });

  test("refuses more files than a record links", async () => {
    const files = Array.from(
      { length: DATA_BOX_MESSAGE_LIMITS.maxFiles + 1 },
      (_, index) => ({
        name: `file-${index}.txt`,
        mimeType: "text/plain",
        content: encode(String(index)),
      }),
    );
    expect(failureReason(await zfoFile({ files }))).toBe("too_many_files");
  });

  test("refuses a file whose content is not base64", async () => {
    const xml = messageXml().replace(
      /<p:dmEncodedContent>[^<]*<\/p:dmEncodedContent>/u,
      "<p:dmEncodedContent>not*base64</p:dmEncodedContent>",
    );
    expect(failureReason(await sealContent(encode(xml)))).toBe("invalid_file");
  });

  test("data-box message parse refuses arbitrary bytes", () => {
    assertProperty(
      "data-box message parse refuses arbitrary bytes",
      fc.property(fc.uint8Array({ maxLength: 2048 }), (bytes) => {
        expect(parseDataBoxMessage(bytes).isErr()).toBe(true);
      }),
    );
  });

  test("data-box message parse survives a corrupted byte", async () => {
    const valid = await zfoFile();
    assertProperty(
      "data-box message parse survives a corrupted byte",
      fc.property(
        fc.nat({ max: valid.length - 1 }),
        fc.integer({ min: 0, max: 255 }),
        (index, value) => {
          const corrupted = valid.slice();
          corrupted[index] = value;
          expect(() => parseDataBoxMessage(corrupted)).not.toThrow();
        },
      ),
    );
  });
});
