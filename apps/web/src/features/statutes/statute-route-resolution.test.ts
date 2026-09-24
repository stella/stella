import { describe, expect, test } from "bun:test";

import {
  createStatuteRouteParams,
  type StatuteRouteParams,
} from "@stll/api-contract/statute-route";

import type { StatuteSlugKey } from "@/features/statutes/queries/statutes";
import {
  resolveStatuteRoute,
  type StatuteRouteReads,
} from "@/features/statutes/statute-route-resolution";

const DOCUMENT_ID = "019dd47d-f507-7c84-b827-980af11b8980";
const ELI = "/eli/cz/sb/2012/89";
const SLUG = "89-2012-sb-obcansky-zakonik";
const DAY = "2021-01-01";

type FakeStatute = { name: string };
const BY_ID: FakeStatute = { name: "by id" };
const ON_DAY: FakeStatute = { name: "in force on the day" };
const DEFAULT: FakeStatute = { name: "the act's default text" };

type ReadLog = {
  byId: string[];
  bySlug: StatuteSlugKey[];
};

type CorpusOptions = {
  /** Whether a consolidation was in force on the requested day. */
  inForceOnDay: boolean;
  /** Whether the slug names a Work at all. */
  known: boolean;
};

/** A corpus answering by id, by slug, and by slug on a day. */
const fakeCorpus = ({ inForceOnDay, known }: CorpusOptions) => {
  const log: ReadLog = { byId: [], bySlug: [] };
  const reads: StatuteRouteReads<FakeStatute> = {
    byId: async (documentId) => {
      log.byId.push(documentId);
      return await Promise.resolve(known ? BY_ID : null);
    },
    bySlug: async (key) => {
      log.bySlug.push(key);
      if (!known) {
        return await Promise.resolve(null);
      }
      if (key.asOf === undefined) {
        return await Promise.resolve(DEFAULT);
      }
      return await Promise.resolve(inForceOnDay ? ON_DAY : null);
    },
  };
  return { log, reads };
};

const routeParams = (
  overrides: Partial<Parameters<typeof createStatuteRouteParams>[0]>,
): StatuteRouteParams =>
  createStatuteRouteParams({
    country: "cze",
    documentId: DOCUMENT_ID,
    eli: ELI,
    slug: null,
    version: null,
    ...overrides,
  });

const KNOWN = { inForceOnDay: true, known: true };

describe("resolving a statute address", () => {
  test("the id form reads the consolidation it names by id, ignoring a day", async () => {
    const { log, reads } = fakeCorpus(KNOWN);

    const resolution = await resolveStatuteRoute(
      { ...routeParams({}), asOf: DAY },
      reads,
    );

    expect(resolution).toEqual({ type: "found", statute: BY_ID, work: BY_ID });
    expect(log).toEqual({ byId: [DOCUMENT_ID], bySlug: [] });
  });

  test("a slug with no day reads the act's default text", async () => {
    const { log, reads } = fakeCorpus(KNOWN);

    const resolution = await resolveStatuteRoute(
      { ...routeParams({ slug: SLUG }), asOf: undefined },
      reads,
    );

    expect(resolution).toEqual({
      type: "found",
      statute: DEFAULT,
      work: DEFAULT,
    });
    expect(log.bySlug).toEqual([{ country: "cze", slug: SLUG }]);
  });

  test("a `/v/` opening and an `?asOf` both ask for that day", async () => {
    for (const request of [
      { ...routeParams({ slug: SLUG, version: DAY }), asOf: undefined },
      { ...routeParams({ slug: SLUG }), asOf: DAY },
    ]) {
      const { log, reads } = fakeCorpus(KNOWN);

      const resolution = await resolveStatuteRoute(request, reads);

      expect(resolution).toEqual({
        type: "found",
        statute: ON_DAY,
        work: ON_DAY,
      });
      expect(log.bySlug).toEqual([{ asOf: DAY, country: "cze", slug: SLUG }]);
    }
  });

  test("a day nothing was in force on falls back to the act", async () => {
    const { log, reads } = fakeCorpus({ inForceOnDay: false, known: true });

    const resolution = await resolveStatuteRoute(
      { ...routeParams({ slug: SLUG, version: DAY }), asOf: undefined },
      reads,
    );

    expect(resolution).toEqual({ type: "found", statute: null, work: DEFAULT });
    expect(log.bySlug).toEqual([
      { asOf: DAY, country: "cze", slug: SLUG },
      { country: "cze", slug: SLUG },
    ]);
  });

  test("an address the corpus does not hold is missing", async () => {
    for (const request of [
      { ...routeParams({}), asOf: undefined },
      { ...routeParams({ slug: SLUG }), asOf: undefined },
      { ...routeParams({ slug: SLUG, version: DAY }), asOf: undefined },
    ]) {
      const { reads } = fakeCorpus({ inForceOnDay: false, known: false });

      expect(await resolveStatuteRoute(request, reads)).toEqual({
        type: "missing",
      });
    }
  });

  test("a jurisdiction the public corpus does not serve reads nothing", async () => {
    const { log, reads } = fakeCorpus(KNOWN);

    const resolution = await resolveStatuteRoute(
      { ...routeParams({ country: "zzz", slug: SLUG }), asOf: undefined },
      reads,
    );

    expect(resolution).toEqual({ type: "unserved" });
    expect(log).toEqual({ byId: [], bySlug: [] });
  });
});
