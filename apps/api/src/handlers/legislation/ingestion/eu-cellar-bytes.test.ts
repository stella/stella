import { expect, test } from "bun:test";

import { decodeEuCellarBytes } from "./eu-cellar-bytes";

const utf8 = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array, contentType = "application/xml") =>
  decodeEuCellarBytes({ bytes, contentType, kind: "notice" });

const failure = (input: Parameters<typeof decodeEuCellarBytes>[0]) => {
  const result = decodeEuCellarBytes(input);
  expect(result.isErr()).toBe(true);
  return result.isErr() ? result.error : null;
};

test("UTF-8 selection preserves source text and hashes the actual byte slice", () => {
  const backing = Uint8Array.from([0, 97, 98, 99, 255]);
  const bytes = backing.subarray(1, 4);
  expect(decode(bytes).unwrap()).toEqual({
    text: "abc",
    charset: "utf-8",
    source: "default",
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  });
  expect(
    decode(utf8("Článek 1 – práva"), 'text/xml; charset="UTF-8"').unwrap(),
  ).toMatchObject({
    text: "Článek 1 – práva",
    charset: "utf-8",
    source: "http",
  });
});

test.each([
  {
    bytes: [255, 254, 97, 0, 98, 0, 99, 0],
    charset: "utf-16le",
    sha256: "aec4cd5ed4c05ed5cf9dea5a8b30f5e655ad87b937b36e3c059840ce3cf3642f",
  },
  {
    bytes: [254, 255, 0, 97, 0, 98, 0, 99],
    charset: "utf-16be",
    sha256: "2565ae43a9e12333ff5a9b4d38afa39990f3fb63530ef0f616fc542471920405",
  },
])(
  "a $charset BOM selects decoding and remains part of the byte hash",
  ({ bytes, charset, sha256 }) => {
    expect(
      decode(
        Uint8Array.from(bytes),
        "application/xml; charset=windows-1250",
      ).unwrap(),
    ).toEqual({ text: "abc", charset, source: "bom", sha256 });
  },
);

test("Windows-1250 uses its transport declaration without replacing Central European letters", () => {
  const bytes = Uint8Array.from([142, 108, 117, 157, 111, 117, 232, 107, 253]);
  expect(
    decode(bytes, "application/xml; charset=windows-1250").unwrap(),
  ).toEqual({
    text: "Žluťoučký",
    charset: "windows-1250",
    source: "http",
    sha256: "a3a547cc905cd34c8efd5b7ba71f474693c07cf5205578be0331d2c0bd350c23",
  });
});

test("the shared document declaration selects decoding when HTTP provides no charset", () => {
  const bytes = Uint8Array.from([
    ...utf8('<?xml version="1.0" encoding="windows-1250"?><p>'),
    142,
    157,
    232,
    ...utf8("</p>"),
  ]);
  expect(decode(bytes).unwrap()).toMatchObject({
    text: '<?xml version="1.0" encoding="windows-1250"?><p>Žťč</p>',
    charset: "windows-1250",
    source: "document",
  });
});

test("malformed UTF-8 and UTF-16 bytes return the strict decoder failure", () => {
  const malformed = [
    Uint8Array.from([0xc3, 0x28]),
    Uint8Array.from([0xe2, 0x82]),
    Uint8Array.from([0xff, 0xfe, 0x61]),
  ];
  for (const bytes of malformed) {
    const error = failure({
      bytes,
      contentType: "application/xml",
      kind: "notice",
    });
    expect(error?.reason).toBe("encoding");
    expect(error?.cause).toBeInstanceOf(TypeError);
  }
});

test("unknown explicit HTTP charset cannot silently become default UTF-8", () => {
  const error = failure({
    bytes: utf8("abc"),
    contentType: "application/xml; charset=not-a-charset",
    kind: "notice",
  });
  expect(error?.reason).toBe("charset");
  const declared = failure({
    bytes: utf8('<?xml version="1.0" encoding="utf-8"?><p>Text</p>'),
    contentType: "application/xml; charset=not-a-charset",
    kind: "notice",
  });
  expect(declared?.reason).toBe("charset");
  expect(
    decode(
      Uint8Array.from([0xef, 0xbb, 0xbf, 97, 98, 99]),
      "application/xml; charset=not-a-charset",
    ).unwrap(),
  ).toMatchObject({ text: "abc", charset: "utf-8", source: "bom" });
});

test("empty responses, decoded whitespace and oversized payloads are refused", () => {
  for (const bytes of [
    new Uint8Array(),
    utf8(" \n\t"),
    Uint8Array.from([0xef, 0xbb, 0xbf]),
  ]) {
    expect(
      failure({ bytes, contentType: "application/xml", kind: "notice" })
        ?.reason,
    ).toBe("empty");
  }
  expect(
    failure({
      bytes: new Uint8Array(8 * 1024 * 1024 + 1),
      contentType: "application/xml",
      kind: "notice",
    })?.reason,
  ).toBe("limits");
});

test("XHTML accepts only its publisher MIME while notice accepts either XML MIME", () => {
  const bytes = utf8("<p>Legal text</p>");
  expect(
    decodeEuCellarBytes({
      bytes,
      contentType: "APPLICATION/XHTML+XML; charset=utf-8",
      kind: "xhtml",
    }).isOk(),
  ).toBe(true);
  expect(decode(bytes, "text/xml").isOk()).toBe(true);
  for (const contentType of [
    null,
    "text/html",
    "application/xml",
    "application/zip",
  ]) {
    expect(failure({ bytes, contentType, kind: "xhtml" })?.reason).toBe("mime");
  }
  expect(
    failure({ bytes, contentType: "application/xhtml+xml", kind: "notice" })
      ?.reason,
  ).toBe("mime");
});
