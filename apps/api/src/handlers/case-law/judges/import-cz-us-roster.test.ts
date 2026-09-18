import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  CzUsRosterListingError,
  type CzUsRosterStore,
  CZ_US_ROSTER_LISTINGS,
  importCzUsRoster,
  parseJusticePage,
  parseRosterListing,
  type RosterFetch,
  type RosterPortrait,
  type StoredRosterJudge,
} from "@/api/handlers/case-law/judges/import-cz-us-roster";
import { judgeNameKey } from "@/api/handlers/case-law/judges/judge-name";
import { createSafeId } from "@/api/lib/branded-types";

const FIXTURES = new URL("__fixtures__/", import.meta.url);

const fixture = async (name: string): Promise<string> =>
  new TextDecoder().decode(
    Bun.gunzipSync(await Bun.file(new URL(name, FIXTURES)).bytes()),
  );

const [SITTING_LISTING_URL, EMERITUS_LISTING_URL] = CZ_US_ROSTER_LISTINGS;

const SITTING_JUSTICE_URL =
  "https://www.usoud.cz/soucasni-funkcionari-a-soudci?tx_odjudges%5Bdetail%5D=106&cHash=5b8419d1295199c2619fbce65d75c945";
const SITTING_PORTRAIT_URL =
  "https://www.usoud.cz/fileadmin/user_upload/ustavni_soud_www/Galerie/Soudci_US/miniatury/Josef_Baxa_predseda.jpg";

describe("the roster listings the court publishes", () => {
  test("state each sitting justice's name, link and appointment", async () => {
    const entries = parseRosterListing({
      html: await fixture("cz-us-roster-sitting.html.gz"),
      listingUrl: SITTING_LISTING_URL,
    });

    expect(entries).toHaveLength(15);
    // The court prints the president's two offices on separate lines, the
    // earlier of which is the appointment to the bench.
    expect(entries.at(0)).toEqual({
      name: "Josef Baxa",
      profileUrl: SITTING_JUSTICE_URL,
      appointedOn: "2023-06-05",
    });
  });

  test("date an entry the court prints without its `od`", async () => {
    const entries = parseRosterListing({
      html: await fixture("cz-us-roster-sitting.html.gz"),
      listingUrl: SITTING_LISTING_URL,
    });

    expect(
      entries.find((entry) => entry.name === "Jiří Přibáň")?.appointedOn,
    ).toBe("2024-06-25");
  });

  test("close the term of a justice who has left the bench", async () => {
    const entries = parseRosterListing({
      html: await fixture("cz-us-roster-emeritus.html.gz"),
      listingUrl: EMERITUS_LISTING_URL,
    });

    expect(
      entries.find((entry) => entry.name === "Josef Fiala")?.appointedOn,
    ).toBe("2015-12-17");
    // A vice-president's line is a bench office too, so an entry naming only
    // that office is still a roster row.
    expect(entries.map((entry) => entry.name)).toContain("Milada Tomková");
  });

  test("leave out an entry naming only the court's secretariat", async () => {
    const html = await fixture("cz-us-roster-emeritus.html.gz");
    const printed = [...html.matchAll(/<h3>(?<name>[^<]+)<\/h3>/gu)].length;
    const entries = parseRosterListing({
      html,
      listingUrl: EMERITUS_LISTING_URL,
    });

    // The general secretary is listed beside the justices; the same person
    // can hold both offices, so their entries must not become roster rows.
    expect(printed).toBe(44);
    expect(entries).toHaveLength(41);
    expect(entries.map((entry) => entry.name)).not.toContain("Ivo Pospíšil");
    expect(entries.map((entry) => entry.name)).not.toContain("Václav Mezřický");
  });

  test("follow the link the listing states rather than building one", async () => {
    const html = await fixture("cz-us-roster-sitting.html.gz");
    const entries = parseRosterListing({
      html,
      listingUrl: SITTING_LISTING_URL,
    });

    for (const entry of entries) {
      const stated = new URL(entry.profileUrl);
      expect(stated.origin).toBe("https://www.usoud.cz");
      // The hash the listing computes cannot be derived, so a profile URL
      // that lost it was constructed rather than followed.
      expect(stated.searchParams.get("cHash")).toMatch(/^[0-9a-f]{32}$/u);
      expect(html).toContain(`${stated.pathname}${stated.search}`);
    }
  });
});

describe("a justice's own page", () => {
  test("leaves the term of a sitting justice open", async () => {
    const parsed = parseJusticePage({
      html: await fixture("cz-us-justice-sitting.html.gz"),
      sourceUrl: SITTING_JUSTICE_URL,
    });

    expect(Result.isOk(parsed)).toBe(true);
    if (Result.isError(parsed)) {
      return;
    }
    expect(parsed.value).toEqual({
      fullName: "Josef Baxa",
      termStart: "2023-06-05",
      portraitUrl: SITTING_PORTRAIT_URL,
      sourceUrl: SITTING_JUSTICE_URL,
    });
  });

  test("closes the term of a justice who has left the bench", async () => {
    const sourceUrl =
      "https://www.usoud.cz/emeritni-funkcionari-a-soudci?tx_odjudges%5Bdetail%5D=97&cHash=7fce3a42bc82869d38d99ac586ae4d37";
    const parsed = parseJusticePage({
      html: await fixture("cz-us-justice-emeritus.html.gz"),
      sourceUrl,
    });

    expect(Result.isOk(parsed)).toBe(true);
    if (Result.isError(parsed)) {
      return;
    }
    expect(parsed.value.fullName).toBe("Josef Fiala");
    expect(parsed.value.termStart).toBe("2015-12-17");
    expect(parsed.value.termEnd).toBe("2025-12-17");
    expect(parsed.value.portraitUrl).toContain("https://www.usoud.cz/");
  });

  test("states no portrait when the page carries none", () => {
    const parsed = parseJusticePage({
      html: '<h1 class="judges_name">JUDr. Jana Nováková</h1><p class="perex">soudkyně Ústavního soudu (od 1. 2. 2020)</p><div id="judges_detail"><p>…</p></div>',
      sourceUrl: SITTING_JUSTICE_URL,
    });

    expect(Result.isOk(parsed)).toBe(true);
    if (Result.isError(parsed)) {
      return;
    }
    expect(parsed.value.portraitUrl).toBeUndefined();
    expect(parsed.value.termStart).toBe("2020-02-01");
  });

  test("is refused when it names nobody", () => {
    const parsed = parseJusticePage({
      html: "<div id='judges_detail'></div>",
      sourceUrl: SITTING_JUSTICE_URL,
    });

    expect(Result.isError(parsed)).toBe(true);
    if (Result.isOk(parsed)) {
      return;
    }
    expect(parsed.error.message).toContain("states no name");
  });
});

/* -- the import ---------------------------------------------------------- */

const RELINKED = 3;

type FakeStore = CzUsRosterStore & {
  rows: Map<string, StoredRosterJudge & { nameKey: string }>;
  relinkCalls: () => number;
};

const fakeStore = (): FakeStore => {
  const rows = new Map<string, StoredRosterJudge & { nameKey: string }>();
  let relinkCalls = 0;
  return {
    rows,
    relinkCalls: () => relinkCalls,
    findByNameKey: async (nameKey) => rows.get(nameKey),
    insertJudge: async (judge) => {
      rows.set(judge.nameKey, { ...judge, portraitS3Key: null });
      return { id: judge.id, inserted: true };
    },
    updateJudge: async ({ id, patch }) => {
      const held = [...rows.entries()].find(
        ([, candidate]) => candidate.id === id,
      );
      if (held === undefined) {
        throw new Error(`no row holds ${id}`);
      }
      rows.set(held[0], { ...held[1], ...patch });
    },
    relinkUnmatched: async () => {
      relinkCalls += 1;
      return RELINKED;
    },
  };
};

const listingWith = (href: string, name: string): string =>
  `<div class="judges-list"><a class="list_polozka" href="${href}">
     <h3>JUDr.&nbsp;${name}</h3>
     <p>soudce Ústavního soudu (od 5. 6. 2023)</p>
   </a></div>`;

const EMPTY_LISTING = '<div class="judges-list"></div>';

type FakeSite = {
  fetch: RosterFetch;
  puts: RosterPortrait[];
  setPortrait: (bytes: Uint8Array) => void;
  s3: { put: (portrait: RosterPortrait) => Promise<void> };
};

const fakeSite = async (): Promise<FakeSite> => {
  const justicePage = await fixture("cz-us-justice-sitting.html.gz");
  const puts: RosterPortrait[] = [];
  let portrait: Uint8Array = new Uint8Array([1, 2, 3, 4]);
  const pages = new Map<string, string>([
    [SITTING_LISTING_URL, listingWith(SITTING_JUSTICE_URL, "Josef&nbsp;Baxa")],
    [EMERITUS_LISTING_URL, EMPTY_LISTING],
    [SITTING_JUSTICE_URL, justicePage],
  ]);
  return {
    puts,
    setPortrait: (bytes) => {
      portrait = bytes;
    },
    s3: {
      put: async (stored) => {
        puts.push(stored);
      },
    },
    fetch: async (url) => {
      if (url === SITTING_PORTRAIT_URL) {
        return new Response(portrait, {
          headers: { "content-type": "image/jpeg" },
        });
      }
      const html = pages.get(url);
      return html === undefined
        ? new Response("not found", { status: 404 })
        : new Response(html, { headers: { "content-type": "text/html" } });
    },
  };
};

const runImport = async (site: FakeSite, store: CzUsRosterStore) =>
  await importCzUsRoster({
    store,
    fetch: site.fetch,
    s3: site.s3,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    intervalMs: 0,
  });

/** A run the test expects to complete; a halt is the test failing, not a case. */
const importedRoster = async (site: FakeSite, store: CzUsRosterStore) => {
  const imported = await runImport(site, store);
  return Result.isError(imported)
    ? panic(`roster import halted: ${imported.error.message}`)
    : imported.value;
};

describe("importing the roster", () => {
  test("stores a justice the court has added, with their portrait", async () => {
    const site = await fakeSite();
    const store = fakeStore();

    const result = await importedRoster(site, store);

    expect(result).toEqual({
      seen: 1,
      inserted: 1,
      updated: 0,
      portraitsStored: 1,
      relinked: RELINKED,
      failures: [],
    });
    const row = store.rows.get(judgeNameKey("Josef Baxa"));
    expect(row?.fullName).toBe("Josef Baxa");
    expect(row?.termStart).toBe("2023-06-05");
    expect(row?.termEnd).toBeNull();
    expect(row?.externalRefs.sourceUrl).toBe(SITTING_JUSTICE_URL);
    expect(site.puts).toHaveLength(1);
    expect(site.puts.at(0)?.key).toBe(`case-law/judges/${row?.id}.jpg`);
    expect(site.puts.at(0)?.contentType).toBe("image/jpeg");
    expect(store.relinkCalls()).toBe(1);
  });

  test("changes nothing on a re-run the court's pages did not change", async () => {
    const site = await fakeSite();
    const store = fakeStore();
    await importedRoster(site, store);
    const first = new Map(store.rows);

    const second = await importedRoster(site, store);

    expect(second).toEqual({
      seen: 1,
      inserted: 0,
      updated: 0,
      portraitsStored: 0,
      relinked: RELINKED,
      failures: [],
    });
    expect(store.rows).toEqual(first);
    expect(site.puts).toHaveLength(1);
  });

  test("transfers a portrait again once its bytes differ", async () => {
    const site = await fakeSite();
    const store = fakeStore();
    await importedRoster(site, store);
    const stored = store.rows.get(judgeNameKey("Josef Baxa"));
    site.setPortrait(new Uint8Array([9, 9, 9, 9, 9]));

    const second = await importedRoster(site, store);

    expect(second.portraitsStored).toBe(1);
    expect(second.updated).toBe(1);
    expect(second.inserted).toBe(0);
    expect(site.puts).toHaveLength(2);
    const refreshed = store.rows.get(judgeNameKey("Josef Baxa"));
    expect(refreshed?.id).toBe(stored?.id);
    expect(refreshed?.externalRefs.portraitSha256).not.toBe(
      stored?.externalRefs.portraitSha256,
    );
    expect(site.puts.at(1)?.bytes).toEqual(new Uint8Array([9, 9, 9, 9, 9]));
  });

  test("reports the justices it could not read and applies the rest", async () => {
    const site = await fakeSite();
    const store = fakeStore();
    const unreachable = `${SITTING_JUSTICE_URL.slice(0, -1)}0`;
    const listings = new Map<string, string>([
      [
        SITTING_LISTING_URL,
        `${listingWith(SITTING_JUSTICE_URL, "Josef&nbsp;Baxa")}${listingWith(unreachable, "Eva&nbsp;Nová")}`,
      ],
    ]);
    const site404: RosterFetch = async (url, init) => {
      const listing = listings.get(url);
      return listing === undefined
        ? await site.fetch(url, init)
        : new Response(listing, { headers: { "content-type": "text/html" } });
    };

    const result = await importedRoster({ ...site, fetch: site404 }, store);

    expect(result.seen).toBe(2);
    expect(result.inserted).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures.at(0)?.name).toBe("Eva Nová");
    expect(result.failures.at(0)?.reason).toContain("404");
    expect(store.rows.has(judgeNameKey("Eva Nová"))).toBe(false);
  });

  test("halts when a listing does not answer", async () => {
    const store = fakeStore();
    const site = await fakeSite();
    const down: RosterFetch = async () => new Response("gone", { status: 503 });

    const imported = await runImport({ ...site, fetch: down }, store);

    expect(Result.isError(imported)).toBe(true);
    if (Result.isOk(imported)) {
      return;
    }
    expect(imported.error).toBeInstanceOf(CzUsRosterListingError);
    expect(store.relinkCalls()).toBe(0);
  });

  test("keeps the id a concurrent run won for the roster key", async () => {
    const site = await fakeSite();
    const store = fakeStore();
    const held = createSafeId<"caseLawJudge">();
    const contended: CzUsRosterStore = {
      ...store,
      insertJudge: async (judge) => {
        await store.insertJudge({ ...judge, id: held });
        return { id: held, inserted: false };
      },
    };

    const result = await importedRoster(site, contended);

    expect(result.inserted).toBe(0);
    expect(site.puts.at(0)?.key).toBe(`case-law/judges/${held}.jpg`);
  });
});
