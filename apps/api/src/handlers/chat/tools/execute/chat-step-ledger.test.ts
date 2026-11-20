import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  CHAT_STEP_LEDGER_LIMITS,
  chatStepLedgerSchema,
} from "@stll/api-contract/chat-step-ledger";
import { rejectionOf } from "@stll/property-testing/rejection";

import { toSafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";

import {
  chatStepRefScope,
  createChatStepLedgerRecorder,
  runRecordedStepCall,
  stepCallSink,
} from "./chat-step-ledger";

const MATTER_ID = toSafeId<"workspace">("0dc54d0c-10d7-501d-897e-e801dbd0998c");
const FOREIGN_MATTER_ID = "7a1f0f7e-2c3b-5d4e-8f90-112233445566";
const DOCUMENT_ID = toSafeId<"entity">("11111111-1111-5111-8111-111111111111");
const FOREIGN_DOCUMENT_ID = "22222222-2222-5222-8222-222222222222";

// A search_case_law hit as the registry answers it after egress: the
// published identity of the decision, its headnote, and fields the ledger
// has no use for.
const caseLawHit = (decisionId: string, caseNumber: string) => ({
  url: `https://app.example.test/law/cze/cases/ustavni-soud/${caseNumber}`,
  source_url: "https://publisher.example.test/decision",
  caseNumber,
  citationCount: 0,
  citationAuthority: 0,
  country: "CZE",
  court: "Ústavní soud",
  courtAbbreviation: "ÚS",
  decisionDate: "2026-04-15T00:00:00.000Z",
  decisionId,
  ecli: "ECLI:CZ:US:2026:3.US.2429.24.1",
  matchedQueries: [0],
  snippet: "I. Skutkové okolnosti",
  headnote: {
    type: "present",
    text: "Zamítne-li soud žalobu pro zmatečnost, nepředstavuje to překážku přístupu k dovolacímu soudu.",
    truncated: false,
  },
});

const searchArgs = {
  queries: ["dovolání podané neoprávněnou osobou", "  "],
  country: "CZE",
  courts: ["Ústavní soud"],
  date_from: "2020-01-01",
  limit: 15,
};

describe("the step ledger", () => {
  test("names each found decision the way a citation does, with what was searched", async () => {
    const recorder = createChatStepLedgerRecorder();
    await runRecordedStepCall({
      recorder,
      tool: "search_case_law",
      callArgs: searchArgs,
      run: async () => {
        stepCallSink().answered({
          args: searchArgs,
          data: {
            results: [
              caseLawHit(
                "f46d5994-ab9f-5a53-8172-80d000959426",
                "III.ÚS 2429/24",
              ),
              caseLawHit(
                "f46d5994-ab9f-5a53-8172-80d000959426",
                "III.ÚS 2429/24",
              ),
            ],
          },
        });
        return await Promise.resolve('{"results":[{"url":"https://app.exa');
      },
    });

    expect(recorder.ledger()).toEqual({
      calls: [
        {
          tool: "search_case_law",
          queries: ["dovolání podané neoprávněnou osobou"],
          filters: [
            { kind: "country", value: "CZE" },
            { kind: "court", value: "Ústavní soud" },
            { kind: "dateFrom", value: "2020-01-01" },
          ],
          outcome: "ok",
          // The same decision twice on one page is one row.
          found: [
            {
              type: "decision",
              decisionId: "f46d5994-ab9f-5a53-8172-80d000959426",
              caseNumber: "III.ÚS 2429/24",
              court: "Ústavní soud",
              courtAbbreviation: "ÚS",
              country: "CZE",
              decisionDate: "2026-04-15",
              ecli: "ECLI:CZ:US:2026:3.US.2429.24.1",
              summary:
                "Zamítne-li soud žalobu pro zmatečnost, nepředstavuje to překážku přístupu k dovolacímu soudu.",
              url: "https://app.example.test/law/cze/cases/ustavni-soud/III.ÚS 2429/24",
              sourceUrl: "https://publisher.example.test/decision",
            },
          ],
          foundOmitted: 0,
        },
      ],
      callsOmitted: 0,
    });
  });

  test("records a failed read with what it asked and nothing found, and lets the failure through", async () => {
    const recorder = createChatStepLedgerRecorder();
    const failure = new Error("The court filter matched no court.");
    const run = runRecordedStepCall({
      recorder,
      tool: "search_case_law",
      callArgs: searchArgs,
      run: async () => {
        // An answer left before the read failed is not what it found.
        stepCallSink().answered({
          args: searchArgs,
          data: { results: [caseLawHit("a-decision", "I.ÚS 1/26")] },
        });
        return await Promise.reject(failure);
      },
    });

    expect(await rejectionOf(run)).toBe(failure);
    expect(recorder.ledger().calls).toMatchObject([
      {
        tool: "search_case_law",
        queries: ["dovolání podané neoprávněnou osobou"],
        outcome: "error",
        found: [],
      },
    ]);
  });

  test("reads a provision with its printed citation and the version it was read in", async () => {
    const recorder = createChatStepLedgerRecorder();
    const args = {
      items: [
        {
          eli: "https://www.e-sbirka.cz/eli/cz/sb/1963/99",
          anchor: "par_243f",
        },
      ],
    };
    await runRecordedStepCall({
      recorder,
      tool: "read_statute_provisions",
      callArgs: args,
      run: async () => {
        stepCallSink().answered({
          args,
          data: {
            items: [
              {
                status: "found",
                eli: "https://www.e-sbirka.cz/eli/cz/sb/1963/99",
                anchor: "par_243f",
                citation: "§ 243f o. s. ř.",
                url: "https://app.example.test/law/cze/statutes/99-1963#par_243f",
                text: "…",
                versionValidFrom: "2026-01-01",
                versionValidTo: null,
              },
              {
                status: "provision_not_found",
                eli: "https://www.e-sbirka.cz/eli/cz/sb/1963/99",
                anchor: "par_9999",
                message: "No such provision.",
              },
            ],
          },
        });
        return await Promise.resolve(null);
      },
    });

    expect(recorder.ledger().calls[0]?.found).toEqual([
      {
        type: "statute",
        eli: "https://www.e-sbirka.cz/eli/cz/sb/1963/99",
        anchor: "par_243f",
        label: "§ 243f o. s. ř.",
        validFrom: "2026-01-01",
        validTo: null,
        url: "https://app.example.test/law/cze/statutes/99-1963#par_243f",
        sourceUrl: null,
      },
    ]);
  });

  test("names a matter document and a matter by the turn's chat refs, and only from the turn's own matters", async () => {
    const refRegistry = createChatRefRegistry();
    const recorder = createChatStepLedgerRecorder(
      chatStepRefScope({ refRegistry, workspaceIds: [MATTER_ID] }),
    );
    const searchArgsForMatters = { query: "indemnity cap" };
    await runRecordedStepCall({
      recorder,
      tool: "search_across_matters",
      callArgs: searchArgsForMatters,
      run: async () => {
        stepCallSink().answered({
          args: searchArgsForMatters,
          data: {
            hits: [
              {
                entityId: DOCUMENT_ID,
                workspaceId: MATTER_ID,
                workspaceName: "Harbrook acquisition",
                name: "Share purchase agreement.docx",
                kind: "document",
              },
              {
                entityId: FOREIGN_DOCUMENT_ID,
                workspaceId: FOREIGN_MATTER_ID,
                workspaceName: "Another client",
                name: "Board minutes.docx",
                kind: "document",
              },
            ],
          },
        });
        return await Promise.resolve(null);
      },
    });
    await runRecordedStepCall({
      recorder,
      tool: "list_matters",
      callArgs: {},
      run: async () => {
        stepCallSink().answered({
          args: {},
          data: {
            matters: [
              { id: MATTER_ID, name: "Harbrook acquisition" },
              { id: FOREIGN_MATTER_ID, name: "Another client" },
            ],
          },
        });
        return await Promise.resolve(null);
      },
    });

    const ledger = recorder.ledger();
    expect(ledger.calls.map((call) => call.found)).toEqual([
      [
        {
          type: "document",
          ref: "ent_1",
          title: "Share purchase agreement.docx",
          kind: "document",
        },
      ],
      [{ type: "matter", ref: "mat_1", title: "Harbrook acquisition" }],
    ]);
    // Each ref is the turn's own spelling of what the read found.
    expect(refRegistry.resolveEntityRefTargets(["ent_1"])).toEqual(
      Result.ok([{ entityId: DOCUMENT_ID, workspaceId: MATTER_ID }]),
    );
    expect(refRegistry.resolveMatterRefs(["mat_1"])).toEqual(
      Result.ok([MATTER_ID]),
    );
    // An item from outside the turn's matters is never named, nor minted a
    // ref the stored message could bind.
    expect(refRegistry.getRegisteredWorkspaceIds()).toEqual([MATTER_ID]);
    // No tenant id rides on the step's result.
    const serialized = JSON.stringify(ledger);
    for (const id of [
      MATTER_ID,
      DOCUMENT_ID,
      FOREIGN_MATTER_ID,
      FOREIGN_DOCUMENT_ID,
    ]) {
      expect(serialized).not.toContain(id);
    }
    expect(v.safeParse(chatStepLedgerSchema, ledger).success).toBe(true);
  });

  test("names no matter item at all without the turn's matters", async () => {
    const recorder = createChatStepLedgerRecorder();
    const args = { matter_id: MATTER_ID };
    await runRecordedStepCall({
      recorder,
      tool: "list_documents",
      callArgs: args,
      run: async () => {
        stepCallSink().answered({
          args,
          data: {
            documents: [{ id: "doc-1", name: "Lease.pdf", kind: "file" }],
          },
        });
        return await Promise.resolve(null);
      },
    });
    expect(recorder.ledger().calls[0]?.found).toEqual([]);
  });

  test("keeps at most its limits and counts the rest", async () => {
    const recorder = createChatStepLedgerRecorder();
    const hits = Array.from(
      { length: CHAT_STEP_LEDGER_LIMITS.refsPerCall + 7 },
      (_, index) =>
        caseLawHit(`decision-${String(index)}`, `I.ÚS ${String(index)}/26`),
    );
    const totalCalls = CHAT_STEP_LEDGER_LIMITS.calls + 3;
    for (let call = 0; call < totalCalls; call += 1) {
      // db-await-in-loop: no I/O, the reads settle in order as a script's would
      await runRecordedStepCall({
        recorder,
        tool: "search_case_law",
        callArgs: {
          queries: Array.from({ length: 9 }, (_, i) => `q${String(i)}`),
        },
        run: async () => {
          stepCallSink().answered({ args: {}, data: { results: hits } });
          return await Promise.resolve(null);
        },
      });
    }

    const ledger = recorder.ledger();
    expect(ledger.calls).toHaveLength(CHAT_STEP_LEDGER_LIMITS.calls);
    expect(ledger.callsOmitted).toBe(3);
    expect(ledger.calls[0]?.found).toHaveLength(
      CHAT_STEP_LEDGER_LIMITS.refsPerCall,
    );
    expect(ledger.calls[0]?.foundOmitted).toBe(7);
    // Whatever was recorded is a ledger the page can read.
    expect(v.safeParse(chatStepLedgerSchema, ledger).success).toBe(true);
  });
});
