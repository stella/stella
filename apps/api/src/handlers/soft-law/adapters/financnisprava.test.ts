import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

import { sha256Hex } from "@stll/sha256/bun";
import { Temporal } from "@stll/time";

import type { SoftLawFetch } from "@/api/lib/legal-search/soft-law-access-types";
import { SoftLawAccessError } from "@/api/lib/legal-search/soft-law-access-types";
import { softLawIdentityKey } from "@/api/lib/legal-search/soft-law-fingerprint";
import type {
  SoftLawDiscoveryEntry,
  SoftLawEntry,
} from "@/api/lib/legal-search/soft-law-types";

import {
  financniSpravaYearEntries,
  GFR_SERIES,
  gfrAdapter,
  MF_SERIES,
  mfAdapter,
  parseFinancniSpravaYearPage,
} from "./financnisprava";
import { configureSoftLawAdapter } from "./registry";

const ORIGIN = "https://financnisprava.gov.cz";
const GFR_YEAR = `${ORIGIN}${GFR_SERIES.yearPath}`;
const MF_YEAR = `${ORIGIN}${MF_SERIES.yearPath}`;
const D72 = `${ORIGIN}/assets/cs/prilohy/d-sprava-dani-a-poplatku/Pokyn_GFR_D_72.pdf`;
const FIXTURES = [
  "financnisprava-gfr-1993.html",
  "financnisprava-gfr-2016.html",
  "financnisprava-gfr-2025.html",
  "financnisprava-mf-2013.html",
  "financnisprava-gfr-d-72.pdf",
] as const;
const fixture = async (name: (typeof FIXTURES)[number]) =>
  gunzipSync(
    await readFile(new URL(`__fixtures__/${name}.gz`, import.meta.url)),
  );
const html = async (name: (typeof FIXTURES)[number]) =>
  (await fixture(name)).toString("utf-8");
const signal = () => AbortSignal.timeout(60_000);
/** Before the 1. 1. 2027 repeal of GFŘ-D-73 takes effect. */
const TODAY = Temporal.PlainDate.from("2026-11-19");
const RETRIEVED_AT = "2026-11-19T15:24:41Z";

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
const publisher = async () => {
  const page = (name: (typeof FIXTURES)[number]) => async () => ({
    bytes: await fixture(name),
    contentType: "text/html; charset=utf-8",
  });
  const responses = new Map([
    [`${GFR_YEAR}/1993`, await page("financnisprava-gfr-1993.html")()],
    [`${GFR_YEAR}/2016`, await page("financnisprava-gfr-2016.html")()],
    [`${GFR_YEAR}/2025`, await page("financnisprava-gfr-2025.html")()],
    [`${MF_YEAR}/2013`, await page("financnisprava-mf-2013.html")()],
    [
      D72,
      {
        bytes: await fixture("financnisprava-gfr-d-72.pdf"),
        contentType: "application/pdf",
      },
    ],
  ]);
  return transport((url) => responses.get(url));
};

type YearEntriesOptions = {
  name: (typeof FIXTURES)[number];
  year: string;
  today?: Temporal.PlainDate;
};
const gfrEntries = async ({ name, year, today = TODAY }: YearEntriesOptions) =>
  financniSpravaYearEntries({
    series: GFR_SERIES,
    html: await html(name),
    pageUrl: `${GFR_YEAR}/${year}`,
    today,
    retrievedAt: RETRIEVED_AT,
  }).unwrap();
const documents = (entries: readonly SoftLawDiscoveryEntry[]) =>
  entries.filter((entry): entry is SoftLawEntry => entry.type === "document");
const byReference = (entries: readonly SoftLawDiscoveryEntry[]) =>
  new Map(
    documents(entries).map((entry) => [
      entry.metadata.statedReference.state === "stated"
        ? entry.metadata.statedReference.value
        : panic("Pokyn rows state their number"),
      entry,
    ]),
  );

test("Finanční správa fixtures preserve publisher response bytes and capture provenance", async () => {
  for (const name of FIXTURES) {
    const provenance: unknown = JSON.parse(
      await readFile(
        new URL(`__fixtures__/${name}.gz.provenance.json`, import.meta.url),
        "utf-8",
      ),
    );
    expect(provenance).toMatchObject({
      sha256: sha256Hex(await fixture(name)),
      sourceUrl: expect.stringContaining(ORIGIN),
      retrievedAt: expect.any(String),
    });
  }
});

test("a year page names its year and every year the series lists", async () => {
  const page = parseFinancniSpravaYearPage(
    await html("financnisprava-gfr-2025.html"),
    GFR_SERIES,
  ).unwrap();
  expect(page.year).toBe("2025");
  expect(page.years.at(0)).toBe("1993");
  expect(page.years.at(-1)).toBe("2026");
  expect(page.years).toHaveLength(34);
  expect(page.rows).toHaveLength(12);
});

test("current pokyny state their number, subject and the repeal the listing notes", async () => {
  const listed = await gfrEntries({
    name: "financnisprava-gfr-2025.html",
    year: "2025",
  });
  const pokyny = byReference(listed.entries);
  expect(listed.nextCursor).toBe("2026");
  expect(pokyny.get("GFŘ-D-72")).toMatchObject({
    url: D72,
    sourcePages: [`${GFR_YEAR}/2025`],
    metadata: {
      title: "Pokyn č. GFŘ-D-72 k promíjení příslušenství daně",
      kind: "guideline",
      sourceKind: "Pokyny řady D",
      issuedOn: { state: "not_stated" },
      expression: { type: "identified", language: "cs" },
      relations: [],
      validity: { state: "not_stated", basis: "source_stated" },
    },
    sourceDates: { listedYear: "2025" },
  });
  // Repealed with effect from 15. 9. 2025: no longer in force.
  expect(pokyny.get("GFŘ-D-67")?.metadata).toMatchObject({
    title: "Pokyn č. GFŘ-D-67 k promíjení příslušenství daně",
    validity: { state: "withdrawn" },
  });
  // Repealed with effect from 1. 1. 2027: still in force today.
  expect(pokyny.get("GFŘ-D-73")?.metadata.validity.state).toBe("not_stated");
  expect(pokyny.get("GFŘ-D-65")?.metadata).toMatchObject({
    validity: { state: "superseded" },
    relations: [
      {
        type: "superseded_by",
        reference: "GFŘ-D-66",
        evidence: { url: `${GFR_YEAR}/2025`, locator: ".b-teaser__text" },
      },
    ],
  });
  const later = byReference(
    (
      await gfrEntries({
        name: "financnisprava-gfr-2025.html",
        year: "2025",
        today: Temporal.PlainDate.from("2027-01-01"),
      })
    ).entries,
  );
  expect(later.get("GFŘ-D-73")?.metadata.validity.state).toBe("withdrawn");
  // Word attachments are recorded as rejected rows, never dropped.
  const rejected = listed.entries.filter((entry) => entry.type === "rejected");
  expect(rejected.map((entry) => new URL(entry.url).pathname)).toEqual([
    "/assets/cs/prilohy/d-sprava-dani-a-poplatku/Pokyn_GFR_D_73-priloha.doc",
    "/assets/cs/prilohy/d-sprava-dani-a-poplatku/Pokyn_GFR_D_68-priloha.doc",
  ]);
  expect(documents(listed.entries)).toHaveLength(10);
});

test("the older series reads its status line as validity and keeps it out of the title", async () => {
  const listed = await gfrEntries({
    name: "financnisprava-gfr-1993.html",
    year: "1993",
  });
  const pokyny = byReference(listed.entries);
  expect(listed.nextCursor).toBe("1994");
  const replaced = [...pokyny.values()].find(
    (entry) => entry.metadata.relations?.at(0)?.reference === "D-105",
  );
  expect(replaced?.metadata).toMatchObject({
    validity: { state: "superseded" },
    relations: [{ type: "superseded_by", reference: "D-105" }],
  });
  expect(replaced?.metadata.title).not.toContain("ZRUŠEN");
  expect(pokyny.get("D-6")?.metadata).toMatchObject({
    title:
      "Pokyn D - 6 Rozhodnutí podle ust. § 96 odst. 2 písm. a) zákona č. 337/1992 Sb. (nevyměření a nevybrání DPH a spotřební daně)",
    validity: { state: "withdrawn" },
  });
  expect(
    listed.entries.find(
      (entry) =>
        entry.type === "rejected" && entry.url.endsWith("/d-zakony/D-39.zip"),
    ),
  ).toMatchObject({ rejection: { tag: "invalid_document" } });
  for (const entry of documents(listed.entries)) {
    const reference = entry.metadata.statedReference;
    expect(reference.state === "stated" ? reference.value : "").toMatch(
      /^D-\d+$/u,
    );
    expect(
      softLawIdentityKey("cz-gfr", entry.metadata, {
        extractionQuality: "text_layer",
        text: "Pokyn",
      }).isOk(),
    ).toBe(true);
  }
});

test("attachments keep their own label; web-page and archive rows are rejected", async () => {
  const listed = await gfrEntries({
    name: "financnisprava-gfr-2016.html",
    year: "2016",
  });
  const pokyny = byReference(listed.entries);
  expect(pokyny.get("GFŘ-D-30")?.metadata.sourceKind).toBe("Pokyny řady D");
  expect(pokyny.get("Příloha k Pokynu GFŘ D-30")?.metadata).toMatchObject({
    title:
      "Příloha k Pokynu GFŘ D-30 příklady stanovení daně paušální částkou.",
    sourceKind: "Příloha pokynu",
  });
  const rejected = listed.entries.filter((entry) => entry.type === "rejected");
  expect(rejected.map((entry) => entry.url)).toContain(
    `${ORIGIN}/assets/cs/prilohy/d-zakony/2016-Pokyn_c_GFR_D-27.zip`,
  );
  // GFŘ-D-29 links only a web page from its description, never a document.
  expect(
    rejected.find((entry) => entry.url.startsWith(`${GFR_YEAR}/2016#row-`)),
  ).toMatchObject({
    rejection: { reason: "The listed row links no document" },
  });
});

test("Pokyny MF walk from their oldest year and name the replacing pokyn", async () => {
  const { fetch, calls } = await publisher();
  const page = (
    await mfAdapter.discover({ cursor: null, signal: signal(), fetch })
  ).unwrap();
  expect(calls).toEqual([`${MF_YEAR}/2013`]);
  expect(page.nextCursor).toBe("2014");
  const pokyny = byReference(page.entries);
  expect([...pokyny.keys()].toSorted()).toEqual(["MF-1", "MF-2", "MF-3"]);
  expect(pokyny.get("MF-1")?.metadata).toMatchObject({
    title: "Pokyn MF - 1 O stanovení lhůt při správě daní",
    sourceKind: "Pokyny MF",
    validity: { state: "superseded" },
    relations: [{ type: "superseded_by", reference: "MF-4" }],
  });
});

test("the walk starts at the oldest year page and refuses a cursor that is not a year", async () => {
  const { fetch, calls } = await publisher();
  const first = (
    await gfrAdapter.discover({ cursor: null, signal: signal(), fetch })
  ).unwrap();
  expect(calls).toEqual([`${GFR_YEAR}/1993`]);
  expect(first.nextCursor).toBe("1994");
  const last = (
    await gfrAdapter.discover({ cursor: "2025", signal: signal(), fetch })
  ).unwrap();
  expect(last.nextCursor).toBe("2026");
  expect(
    (
      await gfrAdapter.discover({ cursor: "../2025", signal: signal(), fetch })
    ).isErr(),
  ).toBe(true);
  // The MF page is not a GFŘ year page.
  expect(
    parseFinancniSpravaYearPage(
      await html("financnisprava-mf-2013.html"),
      GFR_SERIES,
    ).isErr(),
  ).toBe(true);
});

test("a pokyn is read from its captured row and its PDF", async () => {
  const { fetch, calls } = await publisher();
  const page = (
    await gfrAdapter.discover({ cursor: "2025", signal: signal(), fetch })
  ).unwrap();
  const entry =
    documents(page.entries).find((candidate) => candidate.url === D72) ??
    panic("GFŘ-D-72 is listed");
  const document = (
    await gfrAdapter.fetchDocument(entry, { signal: signal(), fetch })
  ).unwrap();
  expect(calls.at(-1)).toBe(D72);
  expect(document.extractionQuality).toBe("text_layer");
  expect(document.text).toContain("k promíjení příslušenství daně");
  expect(document.sourceDates).toEqual({
    listedYear: "2025",
    effectiveFrom: "2025-09-15",
  });
  expect(document.raw.map((part) => [part.role, part.purpose])).toEqual([
    ["index", "discovery"],
    ["document", "document"],
  ]);
  expect(
    softLawIdentityKey("cz-gfr", document.metadata, document).unwrap(),
  ).toContain("gfř-d-72");
  const tampered = {
    ...entry,
    sourceRaw: entry.sourceRaw?.map((part) => ({
      ...part,
      contentBase64: Buffer.from('<div class="b-teaser"></div>').toString(
        "base64",
      ),
    })),
  };
  expect(
    (
      await gfrAdapter.fetchDocument(tampered, { signal: signal(), fetch })
    ).isErr(),
  ).toBe(true);
});

test("both series configure with their defaults only", async () => {
  for (const adapter of [gfrAdapter, mfAdapter]) {
    expect(
      (await configureSoftLawAdapter(adapter, { type: "default" })).isOk(),
    ).toBe(true);
  }
});
