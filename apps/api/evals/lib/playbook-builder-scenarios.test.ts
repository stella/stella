import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { isRecord } from "@/api/lib/type-guards";
import type { Position } from "@/api/lib/workflow/playbook-positions";
import type { InternalToolResult } from "@/api/mcp/tool-types";

import {
  BUILDER_SCENARIOS,
  answerMatterTool,
  scoreScenario,
} from "./playbook-builder-scenarios";
import type {
  BuilderEvent,
  BuilderScenario,
} from "./playbook-builder-scenarios";
import type { StoredPlaybook } from "./playbook-store";

const scenario = (id: string): BuilderScenario =>
  BUILDER_SCENARIOS.find((candidate) => candidate.id === id) ??
  panic(`no scenario ${id}`);

/** The ids a fixture answer lists under `key`, in order. */
const listedIds = (result: InternalToolResult, key: string): string[] => {
  if (result.status !== "success") {
    return panic("the fixture refused a read");
  }
  const rows = isRecord(result.data) ? result.data[key] : undefined;
  return v
    .parse(v.array(v.object({ id: v.string() })), rows)
    .map(({ id }) => id);
};

const [supplyMatterId] = listedIds(
  answerMatterTool("list_matters", {}),
  "matters",
);
const [keller, brandt, vogel] = listedIds(
  answerMatterTool("list_documents", { matter_id: supplyMatterId }),
  "documents",
);
if (
  supplyMatterId === undefined ||
  keller === undefined ||
  brandt === undefined ||
  vogel === undefined
) {
  panic("the supply matter fixture holds three documents");
}

const graded = (issue: string, rule: string): Position => ({
  mode: "graded",
  sourceId: `${issue}-id`,
  issue,
  severity: "medium",
  standard: {
    source: "tiers",
    tiers: {
      acceptable: { rules: [{ id: `${issue}-rule`, text: rule }] },
      fallback: { entries: [] },
      notAcceptable: { rules: [] },
    },
  },
  ask: { mode: "auto" },
  enabled: true,
});

const playbook = (
  perspective: "buyer" | "seller" | "neutral" | undefined,
): StoredPlaybook => ({
  id: "playbook",
  name: "IT services",
  description: null,
  scope: perspective === undefined ? null : { perspective },
  positions: {
    version: 3,
    items: [
      graded("Liability cap", "Capped at 12 months of fees"),
      graded("Payment", "30 days"),
      graded("Term", "24 months"),
    ],
  },
  status: "draft",
  approvedAt: null,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
});

const event = (
  turn: number,
  name: string,
  input: unknown = {},
  questions: readonly string[] = [],
): BuilderEvent => ({
  turn,
  name,
  input,
  questions: questions.map((question) => ({
    question,
    reason: "",
    options: [],
    default: undefined,
  })),
  resentUnchanged: [],
  error: null,
});

const ask = (turn: number, ...questions: string[]) =>
  event(turn, "ask-user", {}, questions);
const read = (turn: number, entityId: string) =>
  event(turn, "read_content_across_matters", { entity_id: entityId });

/** The run the `contracts-later` scenario describes, on the MCP surface. */
const contractsLaterRun = (): BuilderEvent[] => [
  ask(
    1,
    "Do you have past executed agreements to ground the playbook in?",
    "Which side is your organization on?",
    "Which governing law should the playbook assume?",
    "What language should the playbook be written in?",
  ),
  event(1, "save_playbook"),
  ask(2, "Which matters should I search, or all you can access?"),
  event(2, "list_matters"),
  event(2, "list_documents", { matter_id: supplyMatterId }),
  ask(2, "Which of these should I read? Keller GmbH, Brandt AG, Vogel (draft)"),
  read(2, keller),
  read(2, brandt),
  event(2, "save_playbook"),
];

const score = (
  id: string,
  events: BuilderEvent[],
  stored = playbook(undefined),
) =>
  scoreScenario(scenario(id), {
    surface: "mcp",
    documentedReads: new Set(),
    events,
    playbooks: [stored],
  });

/** The same run on the chat surface, with `documentedReads` stubbed up front. */
const scoreOnChat = (
  events: BuilderEvent[],
  documentedReads: readonly string[],
) =>
  scoreScenario(scenario("contracts-later"), {
    surface: "chat",
    documentedReads: new Set(documentedReads),
    events,
    playbooks: [playbook(undefined)],
  });

const discoveryDefects = (defects: readonly string[]) =>
  defects.filter((defect) => defect.includes("before discover_tools"));

describe("contracts-later scoring", () => {
  test("the described run has no defects", () => {
    expect(score("contracts-later", contractsLaterRun())).toEqual([]);
  });

  test("handing the reads to subagents is a defect", () => {
    const events = contractsLaterRun();
    events.splice(4, 0, event(2, "spawn_subagents", { subagents: [] }));
    expect(score("contracts-later", events)).toEqual([
      "handed work to subagents 1 time(s)",
    ]);
  });

  test("looking in matters before asking which ones is a defect", () => {
    const events = contractsLaterRun();
    // Move the "which matters" question below the listing that answered it.
    const [question] = events.splice(2, 1);
    events.splice(4, 0, question ?? panic("the run asks which matters"));
    expect(score("contracts-later", events)).toEqual([
      "looked in matters before asking which ones",
    ]);
  });

  test("reading a document the user did not pick is a defect", () => {
    const events = contractsLaterRun();
    events.splice(8, 0, read(2, vogel));
    expect(score("contracts-later", events)).toEqual([
      "read unconfirmed documents: Services Agreement Nordwind - Vogel (DRAFT v3, supplier markup).docx",
    ]);
  });

  test("looking for contracts in the opening turn is a defect", () => {
    const events = contractsLaterRun();
    events.splice(2, 0, event(1, "list_matters"));
    expect(score("contracts-later", events)).toEqual([
      "looked for contracts after the user declined them",
    ]);
  });

  test("saving several positions in one call is a defect", () => {
    const events = contractsLaterRun();
    events[1] = event(1, "save_playbook", {
      positions: [{ issue: "Liability cap" }, { issue: "Payment" }],
    });
    expect(score("contracts-later", events)).toEqual([
      "saved 2 positions in one call",
    ]);
  });
});

describe("chat-surface discovery scoring", () => {
  test("a documented read written without discover_tools is not a defect", () => {
    const run = contractsLaterRun();
    expect(
      discoveryDefects(
        scoreOnChat(run, ["list_documents", "read_content_across_matters"]),
      ),
    ).toEqual([]);
    expect(discoveryDefects(scoreOnChat(run, []))).toEqual([
      "called list_documents before discover_tools named it",
      "called read_content_across_matters before discover_tools named it",
    ]);
  });

  test("an undocumented read is still a defect until discover_tools names it", () => {
    const run = contractsLaterRun();
    expect(discoveryDefects(scoreOnChat(run, ["list_documents"]))).toEqual([
      "called read_content_across_matters before discover_tools named it",
    ]);
    const discovered = run.flatMap((entry) =>
      entry.name === "list_documents"
        ? [
            event(2, "discover_tools", {
              toolNames: ["external_read_content_across_matters"],
            }),
            entry,
          ]
        : [entry],
    );
    expect(
      discoveryDefects(scoreOnChat(discovered, ["list_documents"])),
    ).toEqual([]);
  });
});

describe("perspective scoring", () => {
  test("a customer saved as a buyer is a defect; no perspective is the reading", () => {
    expect(
      score("contracts-later", contractsLaterRun(), playbook(undefined)),
    ).toEqual([]);
    expect(
      score("contracts-later", contractsLaterRun(), playbook("buyer")),
    ).toEqual(["saved scope.perspective buyer; the side maps to undefined"]);
  });

  test("a receiving party saved as neutral is a defect", () => {
    const events = [
      ask(
        1,
        "Do you have past executed NDAs to share?",
        "Which side are you on?",
        "Which governing law applies?",
        "What language should the playbook use?",
      ),
      event(1, "save_playbook"),
    ];
    expect(
      scoreScenario(scenario("no-documents"), {
        surface: "mcp",
        documentedReads: new Set(),
        events,
        playbooks: [playbook("neutral")],
      }),
    ).toContain("saved scope.perspective neutral; the side maps to undefined");
  });
});
