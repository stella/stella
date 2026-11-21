import { describe, expect, test } from "bun:test";

import { readChatStepRefTargets } from "./chat-step-ledger";

const MATTER_ID = "0dc54d0c-10d7-501d-897e-e801dbd0998c";
const DOCUMENT_ID = "11111111-1111-5111-8111-111111111111";

const context = (refs: unknown[]) => ({
  version: 2,
  refs,
  entities: [],
  unresolvedInputs: [],
  workspaceScope: [],
});

describe("where a step's matter items open", () => {
  test("a document and a matter ref open what their message binds them to", () => {
    expect(
      Object.fromEntries(
        readChatStepRefTargets(
          context([
            {
              ref: "ent_1",
              kind: "entity",
              entity: { type: "entity", id: DOCUMENT_ID },
              workspace: { type: "workspace", id: MATTER_ID },
            },
            {
              ref: "mat_1",
              kind: "matter",
              workspace: { type: "workspace", id: MATTER_ID },
            },
          ]),
        ),
      ),
    ).toEqual({
      ent_1: { type: "document", entityId: DOCUMENT_ID, matterId: MATTER_ID },
      mat_1: { type: "matter", matterId: MATTER_ID },
    });
  });

  test("anything else a message stores opens nothing", () => {
    const stored = [
      // Kinds a step never names.
      {
        ref: "contact_1",
        kind: "contact",
        contact: { type: "contact", id: DOCUMENT_ID },
      },
      { ref: "src_1", kind: "source", href: "#stella-source=x" },
      // A ref spelled for another kind, or not a ref at all.
      {
        ref: "mat_2",
        kind: "entity",
        entity: { type: "entity", id: DOCUMENT_ID },
        workspace: { type: "workspace", id: MATTER_ID },
      },
      {
        ref: DOCUMENT_ID,
        kind: "matter",
        workspace: { type: "workspace", id: MATTER_ID },
      },
      // A binding missing its matter.
      { ref: "ent_2", kind: "entity", entity: { type: "entity", id: "x" } },
    ];
    expect(readChatStepRefTargets(context(stored)).size).toBe(0);
    for (const malformed of [
      undefined,
      null,
      "ent_1",
      { version: 1, refs: [] },
      { version: 2, refs: "ent_1" },
    ]) {
      expect(readChatStepRefTargets(malformed).size).toBe(0);
    }
  });
});
