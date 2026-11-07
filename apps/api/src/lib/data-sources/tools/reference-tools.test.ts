import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import path from "node:path";

import type { EntityCheckResult } from "@stll/business-registries/entity-checks";
import { Temporal } from "@stll/time";

import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { BusinessRegistryHit } from "@/api/lib/business-registries/dispatch";
import type { DataSourceTool } from "@/api/lib/data-sources/contract";
import { runDataSourceTool } from "@/api/lib/data-sources/run";
import type { FilledToolInput } from "@/api/lib/data-sources/run";
import { createCzAresLookupTool } from "@/api/lib/data-sources/tools/cz-ares-lookup";
import { createCzCnbRateTool } from "@/api/lib/data-sources/tools/cz-cnb-rate";
import { createCzIsirProceedingsTool } from "@/api/lib/data-sources/tools/cz-isir-proceedings";

// No network: every source answers from a fixture or a recorded shape.

const NOW = Temporal.Instant.from("2026-10-26T10:00:00Z");

const run = async (tool: DataSourceTool, filled: FilledToolInput) =>
  await runDataSourceTool({
    tool,
    filled,
    context: {
      permit: grantThirdPartyOutboundPermit(),
      observer: "unobserved",
      signal: new AbortController().signal,
    },
    now: NOW,
    timeZone: "Europe/Prague",
  });

// A valid IČO written without its leading zero and with a space.
const SHORT_ICO = "2 5596641";
const ICO = "25596641";

describe("cz.ares.lookup", () => {
  const hit = {
    registry: "ares",
    id: ICO,
    name: "Example a.s.",
    legalForm: "Akciová společnost",
    address: {
      line1: null,
      line2: null,
      postalCode: null,
      city: null,
      region: null,
      country: null,
      textAddress: "Náměstí 1, 110 00 Praha 1",
    },
    registryUrl: `https://ares.gov.cz/ekonomicke-subjekty?ico=${ICO}`,
  } satisfies BusinessRegistryHit;

  test("an IČO is compacted before the lookup and the entry becomes one record", async () => {
    const asked: string[] = [];
    const tool = createCzAresLookupTool({
      lookup: async (ico) => {
        asked.push(ico);
        return hit;
      },
    });
    const cell = (
      await run(tool, { values: { companyId: SHORT_ICO }, uncertainKeys: [] })
    ).unwrap();
    expect(asked).toEqual([ICO]);
    expect(cell.state).toMatchObject({
      status: "resolved",
      input: { companyId: ICO },
      provenance: { url: hit.registryUrl },
      result: {
        kind: "one",
        record: {
          companyId: ICO,
          name: "Example a.s.",
          address: "Náměstí 1, 110 00 Praha 1",
          status: null,
        },
      },
    });
  });

  test("a checksum failure is refused before ARES is asked", async () => {
    const asked: string[] = [];
    const tool = createCzAresLookupTool({
      lookup: async (ico) => {
        asked.push(ico);
        return hit;
      },
    });
    const cell = (
      await run(tool, { values: { companyId: "25596642" }, uncertainKeys: [] })
    ).unwrap();
    expect(asked).toEqual([]);
    expect(cell.state).toMatchObject({
      status: "input-needs-review",
      issues: [{ key: "companyId", code: "invalid" }],
    });
  });

  test("an unknown company is not-found with provenance", async () => {
    const tool = createCzAresLookupTool({ lookup: async () => null });
    const cell = (
      await run(tool, { values: { companyId: ICO }, uncertainKeys: [] })
    ).unwrap();
    expect(cell.state).toMatchObject({
      status: "not-found",
      provenance: { url: `https://ares.gov.cz/ekonomicke-subjekty?ico=${ICO}` },
    });
  });
});

describe("cz.isir.proceedings", () => {
  const base = {
    kind: "cz-insolvency",
    source: {
      name: "Insolvenční rejstřík (ISIR)",
      authority: "Ministerstvo spravedlnosti České republiky",
      url: "https://isir.justice.cz",
    },
    subject: { type: "company-id", value: ICO },
    checkedAt: "2026-10-26T10:00:00Z",
    sourceDataAsOf: "2026-10-26T09:00:00Z",
  } as const;

  const finding = {
    fileNumber: "25 INS 10525/2016",
    court: "Krajský soud v Praze",
    phase: "ended",
    stateCode: "KONKURS",
    matchedBy: "company-id",
    debtor: {
      name: "Example a.s.",
      firstName: null,
      companyId: ICO,
      birthDate: null,
      address: null,
    },
    insolvencyDeclaredOn: "2016-05-02",
    insolvencyEndedOn: "2018-01-15",
    url: "https://isir.justice.cz/isir/ueu/evidence_upadcu_detail.do?id=1",
  } as const;

  const toolAnswering = (outcome: EntityCheckResult) =>
    createCzIsirProceedingsTool({ check: async () => Result.ok(outcome) });

  test("every proceeding becomes a record of an unselected list", async () => {
    const cell = (
      await run(
        toolAnswering({
          ...base,
          status: "found",
          findings: [
            finding,
            { ...finding, fileNumber: "1 INS 1/2020", phase: "ongoing" },
          ],
          totalMatches: 2,
          record: null,
        }),
        { values: { companyId: ICO }, uncertainKeys: [] },
      )
    ).unwrap();
    expect(cell.state).toMatchObject({
      status: "resolved",
      provenance: { sourceDataAsOf: base.sourceDataAsOf },
      result: {
        kind: "many",
        selected: null,
        records: [
          {
            fileNumber: "25 INS 10525/2016",
            phase: "ended",
            declaredOn: "2016-05-02",
          },
          { fileNumber: "1 INS 1/2020", phase: "ongoing" },
        ],
      },
    });
  });

  test("a clear register is an empty list, not a missing answer", async () => {
    const cell = (
      await run(toolAnswering({ ...base, status: "clear", record: null }), {
        values: { companyId: ICO },
        uncertainKeys: [],
      })
    ).unwrap();
    expect(cell.state).toMatchObject({
      status: "resolved",
      result: { kind: "many", records: [] },
    });
  });

  test("a truncated list is a failure, never a partial fact", async () => {
    const outcome = await run(
      toolAnswering({
        ...base,
        status: "found",
        findings: [finding],
        totalMatches: 51,
        record: null,
      }),
      { values: { companyId: ICO }, uncertainKeys: [] },
    );
    expect(outcome.isErr()).toBe(true);
  });

  test("an unavailable register is a failure", async () => {
    const outcome = await run(
      toolAnswering({
        kind: "cz-insolvency",
        source: base.source,
        subject: base.subject,
        checkedAt: base.checkedAt,
        status: "unavailable",
        reason: "timeout",
        detail: null,
      }),
      { values: { companyId: ICO }, uncertainKeys: [] },
    );
    expect(outcome.isErr()).toBe(true);
  });
});

describe("cz.cnb.rate", () => {
  const fixture = async () =>
    await Bun.file(
      path.join(
        import.meta.dir,
        "../../billing/__fixtures__/vat-exchange-rates/cnb-2026-10-23.txt",
      ),
    ).text();

  const toolServing = (text: string, seen: string[]) =>
    createCzCnbRateTool({
      transportFor: () => async (url) => {
        seen.push(url);
        return Result.ok({ status: 200, text });
      },
    });

  test("a rate quoted per 100 units is stored per unit, with its source file", async () => {
    const seen: string[] = [];
    const cell = (
      await run(toolServing(await fixture(), seen), {
        values: { currency: "jpy", date: "2026-10-23" },
        uncertainKeys: [],
      })
    ).unwrap();
    expect(seen).toHaveLength(1);
    expect(cell.state).toMatchObject({
      status: "resolved",
      input: { currency: "JPY", date: "2026-10-23" },
      provenance: { url: seen[0], sourceDataAsOf: "2026-10-23" },
      result: {
        kind: "one",
        record: {
          currency: "JPY",
          rate: "0.13862",
          effectiveDate: "2026-10-23",
        },
      },
    });
  });

  test("a weekend date takes the last published rate", async () => {
    const seen: string[] = [];
    const cell = (
      await run(toolServing(await fixture(), seen), {
        values: { currency: "EUR", date: "2026-10-25" },
        uncertainKeys: [],
      })
    ).unwrap();
    expect(cell.state).toMatchObject({
      status: "resolved",
      result: {
        kind: "one",
        record: {
          currency: "EUR",
          rate: "24.335",
          effectiveDate: "2026-10-23",
        },
      },
    });
  });

  test("koruna itself and a future date are refused before ČNB is asked", async () => {
    const seen: string[] = [];
    const tool = toolServing(await fixture(), seen);
    for (const values of [
      { currency: "CZK", date: "2026-10-23" },
      { currency: "EUR", date: "2026-10-27" },
    ]) {
      const cell = (await run(tool, { values, uncertainKeys: [] })).unwrap();
      expect(cell.state.status).toBe("input-needs-review");
    }
    expect(seen).toEqual([]);
  });

  test("a currency ČNB does not quote is not-found", async () => {
    const seen: string[] = [];
    const cell = (
      await run(toolServing(await fixture(), seen), {
        values: { currency: "XYZ", date: "2026-10-23" },
        uncertainKeys: [],
      })
    ).unwrap();
    expect(cell.state.status).toBe("not-found");
  });
});
