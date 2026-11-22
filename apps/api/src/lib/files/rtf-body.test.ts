import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { rtfMessageBody } from "./rtf-body";

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
