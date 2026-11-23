import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { codePageDecoder, rtfMessageBody } from "./rtf-body";

const read = (rtf: string) =>
  rtfMessageBody(new Uint8Array(Buffer.from(rtf, "latin1")));

describe("an RTF message body", () => {
  test("is the HTML Outlook encapsulates, without the RTF-only parts", () => {
    const rtf = [
      "{\\rtf1\\ansi\\ansicpg1252\\fromhtml1 \\deff0{\\fonttbl{\\f0\\fswiss Arial;}}",
      "{\\*\\htmltag19 <html><body>}",
      "{\\*\\htmltag64 <p>}Sehr geehrter Herr Pfeiffer,{\\*\\htmltag72 </p>}",
      "\\htmlrtf \\par \\htmlrtf0 ",
      "{\\*\\htmltag64 <p>}anbei der Entwurf f\\'fcr die m\\'fcndliche Verhandlung.",
      "{\\*\\htmltag72 </p>}{\\*\\htmltag27 </body></html>}}",
    ].join("\r\n");
    expect(read(rtf)).toEqual({
      type: "html",
      html: "<html><body><p>Sehr geehrter Herr Pfeiffer,</p><p>anbei der Entwurf für die mündliche Verhandlung.</p></body></html>",
    });
  });

  test("is the text of plain RTF, in its code page, with Unicode escapes", () => {
    const rtf = [
      "{\\rtf1\\ansi\\ansicpg1250\\deff0{\\fonttbl{\\f0 Arial;}}{\\colortbl;\\red0\\green0\\blue0;}",
      "{\\*\\generator Riched20;}\\uc1\\pard V\\'e1\\'9een\\'fd pane,\\par",
      "zas\\'edl\\'e1m vyj\\'e1d\\u345?en\\'ed k \\u269?\\'e1stce 148\\~500 K\\u269?.\\par",
      "{\\info{\\title Koncept}}S pozdravem\\tab Mgr. Ond\\'f8ej Kalina}",
    ].join("\r\n");
    expect(read(rtf)).toEqual({
      type: "text",
      text: "Vážený pane,\nzasílám vyjádření k částce 148 500 Kč.\nS pozdravem\tMgr. Ondřej Kalina",
    });
  });

  test("a Unicode escape past a code unit names nothing, and never fails the body", () => {
    expect(
      read("{\\rtf1 Smlouva\\u9999999?\\u-999999? \\u269?\\'e1st}"),
    ).toEqual({
      type: "text",
      text: "Smlouva \u010D\u00E1st",
    });
  });

  test("a declared East Asian code page decodes as itself", () => {
    expect(
      codePageDecoder(932).decode(Uint8Array.from([0x93, 0xfa, 0x96, 0x7b])),
    ).toBe("\u65E5\u672C");
    expect(
      codePageDecoder(936).decode(Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4])),
    ).toBe("\u4E2D\u6587");
  });

  test("a run in a font of another character set decodes in that script", () => {
    const rtf =
      "{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fswiss\\fcharset0 Arial;}" +
      "{\\f1\\fnil\\fcharset128 MS Mincho;}}Tokio {\\f1 \\'93\\'fa\\'96\\'7b} K\\'f6ln}";
    expect(read(rtf)).toEqual({
      type: "text",
      text: "Tokio \u65E5\u672C K\u00F6ln",
    });
  });

  test("a control symbol is one stand-in character of a Unicode escape", () => {
    expect(read("{\\rtf1\\uc1\\u945\\~B}")).toEqual({
      type: "text",
      text: "\u03B1B",
    });
  });

  test("binary data is skipped whole, braces in it included", () => {
    expect(read("{\\rtf1 Before{\\pict\\bin1 {}After}")).toEqual({
      type: "text",
      text: "BeforeAfter",
    });
  });

  test("a control word longer than the specification allows never fails the read", () => {
    const long = `{\\rtf1 \\${"a".repeat(200_000)}1234567890123 Text}`;
    expect(read(long)?.type).toBe("text");
  });

  test("shows nothing for RTF without text", () => {
    expect(read("{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\par }")).toBeNull();
    expect(read("")).toBeNull();
  });

  test("a group nested past the bound shows nothing more, and a stray brace ends nothing", () => {
    const deep = `{\\rtf1 Za\\'e8\\'e1tek${"{".repeat(2000)}skryto${"}".repeat(2000)} konec}}}}`;
    const body = read(deep);
    expect(body?.type).toBe("text");
    expect(body?.type === "text" && body.text).not.toContain("skryto");
    expect(body?.type === "text" && body.text).toContain("konec");
  });

  test("any bytes read without failing", () => {
    assertProperty(
      "any bytes read without failing",
      fc.property(
        fc.oneof(
          fc.uint8Array({ maxLength: 400 }),
          fc
            .array(
              fc.constantFrom(
                "{",
                "}",
                "\\",
                "\\'",
                "\\u",
                "-12",
                "\\par",
                "\\*",
                "\\htmltag",
                "\\fromhtml1",
                "\\htmlrtf",
                "\\htmlrtf0",
                "a",
                " ",
                "9f",
              ),
              { maxLength: 120 },
            )
            .map(
              (parts) => new Uint8Array(Buffer.from(parts.join(""), "latin1")),
            ),
        ),
        (bytes) => {
          const body = rtfMessageBody(bytes);
          expect(
            body === null || body.type === "html" || body.type === "text",
          ).toBe(true);
        },
      ),
    );
  });
});
