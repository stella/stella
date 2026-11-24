import {
  CHAT_STEP_LEDGER_KEY,
  type ChatStepLedger,
} from "@stll/api-contract/chat-step-ledger";

import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools-types";
import type { AuthenticatedUser } from "@/lib/authenticated-user-context";
import { toSafeId } from "@/lib/safe-id";

// One matter-research turn on the seeded firm: a code step that listed the
// matters and searched their documents, with the step ledger the server
// records from those reads. Its items are named by chat refs, which the
// stored message binds to the seed's own matter and documents (seed ids are
// derived from fixed labels, so they are the same on every seeded stack).
const MERIDIAN_MATTER_ID = toSafeId<"workspace">(
  "6cbf3f81-bcc9-55da-8a4e-840221d4cabe",
);
const SUPPLIER_AGREEMENT_ID = toSafeId<"entity">(
  "84824638-eb81-58c5-8a81-5d7e961fb7d5",
);
const SHARE_ACQUISITION_AGREEMENT_ID = toSafeId<"entity">(
  "6239fbec-6000-5081-85bf-30e91666bcfe",
);
const UNREADABLE_DOCUMENT_ID = toSafeId<"entity">(
  "0a1c0de0-0000-5000-8000-000000000003",
);

/**
 * The viewer a chip's own reads key their cache by; the reads themselves go
 * out with the signed-in session, so a matter the seeded member can open
 * shows as one.
 */
export const CHAT_MATTER_READS_VIEWER = {
  id: "fixture-viewer",
  activeOrganizationId: "fixture-organization",
  email: "viewer@example.test",
  image: null,
  name: "Viewer",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
} satisfies AuthenticatedUser;

const LEDGER = {
  calls: [
    {
      tool: "list_matters",
      queries: [],
      filters: [],
      outcome: "ok",
      found: [
        { type: "matter", ref: "mat_1", title: "Meridian supply agreement" },
      ],
      foundOmitted: 0,
    },
    {
      tool: "search_across_matters",
      queries: ["limitation of liability cap"],
      filters: [],
      outcome: "ok",
      found: [
        {
          type: "document",
          ref: "ent_1",
          title: "Supplier_Agreement.docx",
          kind: "document",
        },
        {
          type: "document",
          ref: "ent_2",
          title: "Share_Acquisition_Agreement.pdf",
          kind: "document",
        },
        {
          type: "document",
          ref: "ent_3",
          title: "Side_Letter_Northstar.docx",
          kind: "document",
        },
      ],
      foundOmitted: 0,
    },
  ],
  callsOmitted: 0,
} satisfies ChatStepLedger;

const SCRIPT = [
  "const matters = await external_list_matters({});",
  'const hits = await external_search_across_matters({ query: "limitation of liability cap" });',
  'return hits.hits.map((hit) => hit.name).join(", ");',
].join("\n");

export const CHAT_MATTER_READS_CASSETTE = [
  {
    createdAt: new Date("2026-11-19T09:00:00.000Z"),
    edited: false,
    id: "01a1c0de-0000-7000-8000-000000000001",
    role: "user",
    revision: 0,
    parts: [
      {
        type: "text",
        content: "Which of our agreements cap the supplier's liability?",
      },
    ],
  },
  {
    createdAt: new Date("2026-11-19T09:00:20.000Z"),
    edited: false,
    id: "01a1c0de-0000-7000-8000-000000000002",
    metadata: {
      turnModel: { model: "claude-sonnet-5-5", provider: "anthropic" },
      turnOutcome: { type: "completed" },
      refEncoding: "persisted-resource-refs-v2",
      // What the stored turn binds each ref it showed to. `ent_3` names a
      // document the viewer can no longer read, so it opens nowhere.
      refContext: {
        version: 2,
        refs: [
          {
            ref: "mat_1",
            kind: "matter",
            workspace: { type: "workspace", id: MERIDIAN_MATTER_ID },
          },
          {
            ref: "ent_1",
            kind: "entity",
            entity: { type: "entity", id: SUPPLIER_AGREEMENT_ID },
            workspace: { type: "workspace", id: MERIDIAN_MATTER_ID },
          },
          {
            ref: "ent_2",
            kind: "entity",
            entity: { type: "entity", id: SHARE_ACQUISITION_AGREEMENT_ID },
            workspace: { type: "workspace", id: MERIDIAN_MATTER_ID },
          },
          {
            ref: "ent_3",
            kind: "entity",
            entity: { type: "entity", id: UNREADABLE_DOCUMENT_ID },
            workspace: { type: "workspace", id: MERIDIAN_MATTER_ID },
          },
        ],
        entities: [],
        unresolvedInputs: [],
        workspaceScope: [{ type: "workspace", id: MERIDIAN_MATTER_ID }],
      },
    },
    role: "assistant",
    revision: 0,
    parts: [
      {
        type: "tool-call",
        id: "toolu_01MatterReadsCassette1",
        name: "execute_typescript",
        arguments: JSON.stringify({ typescriptCode: SCRIPT }),
        input: { typescriptCode: SCRIPT },
        state: "complete",
        output: {
          logs: [],
          success: true,
          result:
            "Supplier_Agreement.docx, Share_Acquisition_Agreement.pdf, Side_Letter_Northstar.docx",
          [CHAT_STEP_LEDGER_KEY]: LEDGER,
        },
      },
      {
        type: "text",
        content:
          "Two agreements in **Meridian supply agreement** cap the supplier's liability: the supplier agreement caps it at the fees paid in the preceding twelve months, and the share acquisition agreement caps warranty claims at 30% of the purchase price.",
      },
    ],
  },
] satisfies PersistedChatMessage[];
