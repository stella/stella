import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  wp29Adapter,
  parseWp29Archive,
  parseWp29NewsroomDocument,
  parseWp29NewsroomIndex,
} from "./wp29";

const fixture = async (name: string) =>
  new TextDecoder().decode(
    Bun.gunzipSync(
      await Bun.file(new URL(`__fixtures__/${name}`, import.meta.url)).bytes(),
    ),
  );
const ARCHIVE =
  "https://ec.europa.eu/justice/article-29/documentation/opinion-recommendation/index_en.htm";
const GUIDELINES =
  "https://ec.europa.eu/newsroom/article29/items/itemType/1360";
const TRANSPARENCY =
  "https://ec.europa.eu/newsroom/article29/redirection/item/622227";
const parseTransparency = (html: string) =>
  parseWp29NewsroomDocument({ html, url: TRANSPARENCY, indexUrl: GUIDELINES });

describe("WP29 official source shapes", () => {
  test("archive revisions retain their source identities and excluded annual reports stay outside the collection", async () => {
    const result = parseWp29Archive(await fixture("wp29-archive.html.gz"));
    expect(result.status).toBe("ok");
    if (result.status === "error") {
      return;
    }
    const entries = result.value;
    expect(entries.length).toBeGreaterThan(150);
    expect(new Set(entries.map(({ url }) => url)).size).toBe(entries.length);
    const update = entries.find(
      ({ metadata }) =>
        metadata.statedReference.state === "stated" &&
        metadata.statedReference.value === "WP 179 update",
    );
    expect(update?.metadata.expression).toEqual({
      type: "identified",
      language: "en",
      revision: { state: "stated", value: "update" },
    });
    const parts = entries.filter(
      ({ metadata }) =>
        metadata.statedReference.state === "stated" &&
        metadata.statedReference.value === "WP 54",
    );
    expect(parts).toHaveLength(0);
    for (const entry of entries) {
      expect(entry.sourcePages).toEqual([ARCHIVE]);
      expect(entry.metadata.stage).toEqual({ state: "not_stated" });
      expect(entry.metadata.issuedOn).toEqual({ state: "not_stated" });
      expect(entry.metadata.relations).toEqual([]);
    }
  });

  test.each([
    "relative",
    "absolute",
    "relative-query",
    "absolute-query",
  ] as const)(
    "Word-only recommendations preserve discovery locators, source bytes and extraction failures (%s)",
    async (variant) => {
      const originalHtml = await fixture("wp29-archive.html.gz");
      const relative =
        "/justice/article-29/documentation/opinion-recommendation/files/2012/wp195a_application_form_en.doc";
      const base = variant.startsWith("absolute")
        ? new URL(relative, ARCHIVE).href
        : relative;
      const href = variant.endsWith("query")
        ? `${base}?download=1&lang=en`
        : base;
      const html = originalHtml.replace(
        `href="${relative}"`,
        () => `href="${href.replaceAll("&", "&amp;")}"`,
      );
      if (variant !== "relative") {
        expect(html).not.toBe(originalHtml);
      }
      const entries = parseWp29Archive(html).unwrap();
      const entry = entries.find(
        ({ metadata }) =>
          metadata.statedReference.state === "stated" &&
          metadata.statedReference.value === "WP 195a",
      );
      expect(entry).toBeDefined();
      if (!entry) {
        return;
      }
      expect(entry.url).toBe(new URL(href, ARCHIVE).href);
      const urls: string[] = [];
      const bytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]);
      const read = Object.assign(
        async (url: string) => {
          urls.push(url);
          return Result.ok({ bytes, contentType: "application/msword" });
        },
        {
          getBlockReason: () => null,
          getWindowState: () => "open" as const,
          getLeaseState: () => "active" as const,
        },
      );
      const result = await wp29Adapter.fetchDocument(
        {
          ...entry,
          sourceRaw: [
            {
              role: "source-page-0",
              contentBase64: Buffer.from(html).toString("base64"),
              contentType: "text/html",
            },
          ],
        },
        { signal: new AbortController().signal, fetch: read },
      );
      expect(result.status).toBe("ok");
      if (result.status === "error") {
        return;
      }
      expect(urls).toEqual([entry.url]);
      expect(result.value.extractionQuality).toBe("extraction_failed");
      expect(result.value.text).toBeNull();
      expect(
        result.value.raw.find(({ role }) => role === "source-page-0")?.purpose,
      ).toBe("discovery");
      expect(
        result.value.raw.find(({ role }) => role === "document-word"),
      ).toMatchObject({ bytes, purpose: "document" });
    },
  );

  test("archive reference or markup loss cannot become an empty successful census", () => {
    const parsed = parseWp29Archive(
      "<html><body>Temporarily unavailable</body></html>",
    );
    expect(parsed.status).toBe("error");
    if (parsed.status === "error") {
      expect(parsed.error.message).toContain("year sections");
    }
  });

  test("category feeds expose every shown item and ignore header menu controls and footer news", async () => {
    const guidelines = parseWp29NewsroomIndex(
      await fixture("wp29-guidelines.html.gz"),
      GUIDELINES,
    );
    const opinions = parseWp29NewsroomIndex(
      await fixture("wp29-opinions.html.gz"),
      "https://ec.europa.eu/newsroom/article29/items/itemType/1308",
    );
    expect(guidelines.status).toBe("ok");
    expect(opinions.status).toBe("ok");
    if (guidelines.status === "error" || opinions.status === "error") {
      return;
    }
    expect(guidelines.value).toHaveLength(10);
    expect(opinions.value).toHaveLength(19);
    expect(guidelines.value).toContain(TRANSPARENCY);
    for (const url of [...guidelines.value, ...opinions.value]) {
      expect(url).toMatch(
        /^https:\/\/ec\.europa\.eu\/newsroom\/article29\/redirection\/item\/\d+$/u,
      );
    }
  });

  test("English PDF and translation ZIP are one instrument with an identified revision", async () => {
    const result = parseTransparency(
      await fixture("wp29-transparency.html.gz"),
    );
    expect(result.status).toBe("ok");
    if (result.status === "error") {
      return;
    }
    expect(result.value).toHaveLength(1);
    const document = result.value.at(0);
    expect(document?.url).toBe(
      "https://ec.europa.eu/newsroom/article29/redirection/document/51025",
    );
    expect(document?.metadata.statedReference).toEqual({
      state: "stated",
      value: "wp260rev.01",
    });
    expect(document?.metadata.expression).toEqual({
      type: "identified",
      language: "en",
      revision: { state: "stated", value: "rev.01" },
    });
    expect(document?.metadata.issuedOn).toEqual({ state: "not_stated" });
    expect(document?.sourceDates).toEqual({ publisherDate: "22/08/2018" });
  });

  test("asset duplication and whitespace changes preserve the document set", async () => {
    const html = await fixture("wp29-transparency.html.gz");
    const modified = html
      .replace("English", "  English  ")
      .replace(
        "</body>",
        '<a href="https://ec.europa.eu/newsroom/article29/redirection/document/51025">duplicate navigation</a></body>',
      );
    expect(parseTransparency(modified)).toEqual(parseTransparency(html));
  });

  test("an off-publisher download fails instead of crossing the source boundary", async () => {
    const html = await fixture("wp29-transparency.html.gz");
    const changed = html.replace(
      "https://ec.europa.eu/newsroom/article29/redirection/document/51025",
      "https://example.org/newsroom/article29/redirection/document/51025",
    );
    expect(changed).not.toBe(html);
    const result = parseTransparency(changed);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("source boundary");
    }
  });

  test("unknown asset language and missing source metadata are explicit failures", async () => {
    const html = await fixture("wp29-transparency.html.gz");
    const changed = html.replace(
      '<div class="ecl-file__language">English</div>',
      '<div class="ecl-file__language">Unknown</div>',
    );
    expect(changed).not.toBe(html);
    expect(parseTransparency(changed).status).toBe("error");
    expect(parseTransparency("<html><h1>Unavailable</h1></html>").status).toBe(
      "error",
    );
  });
});
