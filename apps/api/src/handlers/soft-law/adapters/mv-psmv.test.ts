import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

import { sha256Hex } from "@stll/sha256/bun";
import { createTestState } from "@stll/test-state";

import type { SoftLawFetch } from "@/api/lib/legal-search/soft-law-access-types";
import { SoftLawAccessError } from "@/api/lib/legal-search/soft-law-access-types";
import { softLawIdentityKey } from "@/api/lib/legal-search/soft-law-fingerprint";
import {
  SOFT_LAW_SERVE_MODE,
  softLawAccessOf,
  softLawServingSettingOf,
} from "@/api/lib/legal-search/soft-law-serving";
import type { SoftLawEntry } from "@/api/lib/legal-search/soft-law-types";

import { MV_PSMV_PAGE_URL, mvPsmvAdapter, parseMvPsmvListing } from "./mv-psmv";

const testState = createTestState({ file: import.meta.path, config: {} });
const PERMISSION = "SOFT_LAW_FULL_TEXT_PERMITTED_SOURCES";
const ZAVER_190 =
  "https://mv.gov.cz/documents/zaverc190-2025?disposition=attachment";
const fixture = async (name: string) =>
  gunzipSync(
    await readFile(new URL(`__fixtures__/${name}.gz`, import.meta.url)),
  );
const listingHtml = async () =>
  (await fixture("mv-psmv-listing.html")).toString("utf-8");
const signal = () => AbortSignal.timeout(60_000);

type FixtureResponse = { bytes: Uint8Array; contentType: string };
const transport = (respond: (url: string) => FixtureResponse | undefined) => {
  const calls: string[] = [];
  const fetch: SoftLawFetch = Object.assign(
    async (url: string) => {
      calls.push(url);
      const response = respond(url);
      return response
        ? Result.ok(response)
        : Result.err(
            new SoftLawAccessError({ message: "Unexpected fixture request" }),
          );
    },
    {
      getBlockReason: () => null,
      getWindowState: () => "open" as const,
      getLeaseState: () => "active" as const,
    },
  );
  return { fetch, calls };
};
// The závěry are not committed: a full-text read is exercised with another
// publisher's PDF, since the adapter reads any PDF the locator serves.
const publisher = async () => {
  const page = {
    bytes: await fixture("mv-psmv-listing.html"),
    contentType: "text/html; charset=utf-8",
  };
  const pdf = {
    bytes: await fixture("financnisprava-gfr-d-72.pdf"),
    contentType: "application/pdf",
  };
  return transport((url) => {
    if (url === MV_PSMV_PAGE_URL) {
      return page;
    }
    return url === ZAVER_190 ? pdf : undefined;
  });
};
const walk = async (fetch: SoftLawFetch, start: string | null = null) => {
  const entries: SoftLawEntry[] = [];
  let cursor = start;
  do {
    const page = (
      await mvPsmvAdapter.discover({ cursor, signal: signal(), fetch })
    ).unwrap();
    for (const entry of page.entries) {
      entries.push(
        entry.type === "document" ? entry : panic("MV rows are documents"),
      );
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return entries;
};

test("the MV listing fixture preserves the publisher response bytes", async () => {
  const provenance: unknown = JSON.parse(
    await readFile(
      new URL(
        "__fixtures__/mv-psmv-listing.html.gz.provenance.json",
        import.meta.url,
      ),
      "utf-8",
    ),
  );
  expect(provenance).toMatchObject({
    sha256: sha256Hex(await fixture("mv-psmv-listing.html")),
    sourceUrl: MV_PSMV_PAGE_URL,
  });
});

test("the listing yields every závěr and dodatek with its number, title and note", async () => {
  const listing = parseMvPsmvListing(await listingHtml()).unwrap();
  expect(listing).toHaveLength(192);
  expect(listing.filter((entry) => entry.addendum)).toHaveLength(2);
  expect(listing.at(0)).toMatchObject({
    reference: "190/2025",
    year: "2025",
    url: ZAVER_190,
    title:
      "Uplatnění pravidel pro ukládání úhrnného správního trestu při souběhu přestupků téhož pachatele",
  });
  expect(listing.at(-1)).toMatchObject({ reference: "1/2005", year: "2005" });
  expect(
    listing.find((entry) => entry.reference === "Dodatek k závěru č. 158/2017"),
  ).toMatchObject({ addendum: true });
});

test("the listing note states validity and the replacing závěr", async () => {
  const { fetch } = await publisher();
  const entries = new Map(
    (await walk(fetch)).map((entry) => [
      entry.metadata.statedReference.state === "stated"
        ? entry.metadata.statedReference.value
        : panic("Every závěr states its number"),
      entry.metadata,
    ]),
  );
  expect(entries.size).toBe(192);
  expect(entries.get("177/2022")).toMatchObject({
    kind: "opinion",
    validity: { state: "superseded", basis: "source_stated" },
    relations: [{ type: "superseded_by", reference: "190/2025" }],
  });
  expect(entries.get("93/2010")?.validity.state).toBe("superseded");
  expect(entries.get("164/2018")?.validity.state).toBe(
    "historical_repealed_basis",
  );
  expect(entries.get("179/2022")?.validity.state).toBe("not_stated");
  expect(entries.get("190/2025")?.title).toBe(
    "Závěr č. 190/2025: Uplatnění pravidel pro ukládání úhrnného správního trestu při souběhu přestupků téhož pachatele",
  );
});

test("without the Ministry's permission only the listing is read and served", async () => {
  const { fetch, calls } = await publisher();
  const entries = await walk(fetch);
  expect(new Set(calls)).toEqual(new Set([MV_PSMV_PAGE_URL]));
  const entry =
    entries.find((candidate) => candidate.url === ZAVER_190) ??
    panic("Závěr 190/2025 is listed");
  const before = calls.length;
  const document = (
    await mvPsmvAdapter.fetchDocument(entry, { signal: signal(), fetch })
  ).unwrap();
  expect(calls).toHaveLength(before);
  expect(document.extractionQuality).toBe("html");
  expect(document.text).toContain("190/2025");
  expect(document.raw.map((part) => [part.role, part.purpose])).toEqual([
    ["listing-row", "document"],
  ]);
  expect(
    softLawIdentityKey("cz-mv-psmv", document.metadata, document).isOk(),
  ).toBe(true);
  const setting = softLawServingSettingOf("cz-mv-psmv");
  expect(setting.serve).toBe(SOFT_LAW_SERVE_MODE.metadataLink);
  for (const surface of ["people", "mcp", "chat"] as const) {
    expect(softLawAccessOf(setting, { surface, kind: "opinion" })).toBe(
      "metadata",
    );
  }
});

test("a recorded permission switches the source to full text without a code change", async () => {
  testState.setEnv(PERMISSION, "cz-mv-psmv");
  const setting = softLawServingSettingOf("cz-mv-psmv");
  expect(setting.serve).toBe(SOFT_LAW_SERVE_MODE.full);
  expect(softLawAccessOf(setting, { surface: "chat", kind: "opinion" })).toBe(
    "text",
  );
  const { fetch, calls } = await publisher();
  const entry =
    (await walk(fetch)).find((candidate) => candidate.url === ZAVER_190) ??
    panic("Závěr 190/2025 is listed");
  const document = (
    await mvPsmvAdapter.fetchDocument(entry, { signal: signal(), fetch })
  ).unwrap();
  expect(calls.at(-1)).toBe(ZAVER_190);
  expect(document.extractionQuality).toBe("text_layer");
  expect(document.raw.map((part) => [part.role, part.purpose])).toEqual([
    ["listing-row", "discovery"],
    ["document", "document"],
  ]);
});

test("only a permission-gated source can be named as permitted", () => {
  testState.setEnv(PERMISSION, "cz-uoou");
  expect(() => softLawServingSettingOf("cz-mv-psmv")).toThrow(/cz-uoou/u);
  testState.setEnv(PERMISSION, " , ");
  expect(softLawServingSettingOf("cz-mv-psmv").serve).toBe(
    SOFT_LAW_SERVE_MODE.metadataLink,
  );
});

test("a retry refuses a row that no longer names its document", async () => {
  const { fetch } = await publisher();
  const entry =
    (await walk(fetch)).find((candidate) => candidate.url === ZAVER_190) ??
    panic("Závěr 190/2025 is listed");
  const other = {
    ...entry,
    url: "https://mv.gov.cz/documents/zaverc189-2025?disposition=attachment",
  };
  expect(
    (
      await mvPsmvAdapter.fetchDocument(other, { signal: signal(), fetch })
    ).isErr(),
  ).toBe(true);
});
