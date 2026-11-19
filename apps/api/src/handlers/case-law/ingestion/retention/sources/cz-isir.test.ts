import { describe, expect, test } from "bun:test";

import { czIsirRetention } from "@/api/handlers/case-law/ingestion/retention/sources/cz-isir";
import { encodeSourceRawEnvelope } from "@/api/lib/legal-search/ingestion-types";

const project = async (sourceRaw: string) =>
  await czIsirRetention.project(sourceRaw);

describe("czIsirRetention", () => {
  test("reads the stored paragraphs back, as stored", async () => {
    const sourceRaw = encodeSourceRawEnvelope({
      action: JSON.stringify({ id: 1 }),
      text: JSON.stringify([
        { text: "USNESENÍ", bold: true },
        { text: " Vrchní soud v Praze rozhodl. ", bold: false },
        { text: "", bold: false },
      ]),
    });
    expect(await project(sourceRaw)).toEqual({
      type: "source",
      source: {
        type: "paragraphs",
        paragraphs: ["USNESENÍ", "Vrchní soud v Praze rozhodl."],
      },
    });
  });

  test("names a payload without its text, or one that is not the envelope", async () => {
    expect(
      await project(encodeSourceRawEnvelope({ action: "{}" })),
    ).toMatchObject({ type: "unreadable", reason: "missing-text-part" });
    expect(await project("not an envelope")).toMatchObject({
      type: "unreadable",
    });
    expect(
      await project(encodeSourceRawEnvelope({ action: "{}", text: "[1]" })),
    ).toMatchObject({ type: "unreadable" });
  });

  test("a stored text of empty paragraphs holds no text", async () => {
    expect(
      await project(
        encodeSourceRawEnvelope({
          action: "{}",
          text: JSON.stringify([{ text: " ", bold: false }]),
        }),
      ),
    ).toMatchObject({ type: "no-text" });
  });
});
