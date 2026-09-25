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

/** The rows a fixture answer lists under `key`, in order. */
const listedRows = (result: InternalToolResult, key: string) => {
  if (result.status !== "success") {
    return panic("the fixture refused a read");
  }
  const rows = isRecord(result.data) ? result.data[key] : undefined;
  return v.parse(v.array(v.object({ id: v.string(), name: v.string() })), rows);
};
const listedIds = (result: InternalToolResult, key: string): string[] =>
  listedRows(result, key).map(({ id }) => id);

const matters = listedRows(answerMatterTool("list_matters", {}), "matters");
const [supplyMatterId] = matters.map(({ id }) => id);
const MATTER_OPTIONS = [
  ...matters.map(({ name }) => name),
  "All matters I can access",
];
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
  options: readonly string[] = [],
): BuilderEvent => ({
  turn,
  name,
  input,
  questions: questions.map((question) => ({
    question,
    reason: "",
    options,
    default: undefined,
  })),
  resentUnchanged: [],
  error: null,
});

const ask = (turn: number, ...questions: string[]) =>
  event(turn, "ask-user", {}, questions);
/** One question answered by picking from `options`. */
const askWith = (turn: number, question: string, options: readonly string[]) =>
  event(turn, "ask-user", {}, [question], options);
const WHICH_MATTERS = "Which matters should I search, or all you can access?";
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
  event(2, "list_matters"),
  askWith(2, WHICH_MATTERS, MATTER_OPTIONS),
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
  replies: readonly string[] = [],
) =>
  scoreScenario(scenario(id), {
    surface: "mcp",
    documentedReads: new Set(),
    events,
    replies,
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
    replies: [],
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
    const [question] = events.splice(3, 1);
    events.splice(4, 0, question ?? panic("the run asks which matters"));
    expect(score("contracts-later", events)).toEqual([
      "looked in matters before asking which ones",
    ]);
  });

  test("asking which matters before listing them is a defect", () => {
    const events = contractsLaterRun();
    const [listing] = events.splice(2, 1);
    events.splice(3, 0, listing ?? panic("the run lists the matters"));
    expect(score("contracts-later", events)).toEqual([
      "asked which matters before listing them",
    ]);
  });

  test("asking which matters without offering them is a defect", () => {
    const events = contractsLaterRun();
    events[3] = ask(2, WHICH_MATTERS);
    expect(score("contracts-later", events)).toEqual([
      `asked which matters without offering ${matters.map(({ name }) => name).join(", ")} as an option`,
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

describe("scripted answers", () => {
  test("the matters question is answered with a matter, not a document pick", () => {
    const [question] = askWith(1, WHICH_MATTERS, MATTER_OPTIONS).questions;
    expect(
      scenario("discovery").answer(
        question ?? panic("the helper builds one question"),
        [],
      ),
    ).toBe(`The "${matters.at(0)?.name ?? ""}" matter.`);
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
        replies: [],
        playbooks: [playbook("neutral")],
      }),
    ).toContain("saved scope.perspective neutral; the side maps to undefined");
  });
});

/** The run the `grounding-later` scenario describes, on the MCP surface. */
const GROUNDING_QUESTION =
  "Should I ground these positions in your executed contracts?";
const GROUNDING_OPTIONS = [
  "Look in my matters",
  "Attach them",
  "Finish without",
];
const groundingLaterRun = (): BuilderEvent[] => [
  ask(
    1,
    "Do you have past executed agreements to ground the playbook in?",
    "Which side is your organization on?",
    "Which governing law should the playbook assume?",
  ),
  event(1, "save_playbook"),
  event(1, "save_playbook"),
  askWith(1, GROUNDING_QUESTION, GROUNDING_OPTIONS),
  event(1, "list_matters"),
  askWith(1, WHICH_MATTERS, MATTER_OPTIONS),
  event(1, "list_documents", { matter_id: supplyMatterId }),
  ask(1, "Which of these should I read? Keller GmbH, Brandt AG, Vogel (draft)"),
  read(1, keller),
  read(1, brandt),
  event(1, "save_playbook"),
];

describe("grounding-later scoring", () => {
  test("the described run has no defects", () => {
    expect(score("grounding-later", groundingLaterRun())).toEqual([]);
  });

  test("the script says yes only to the grounding question after a save", () => {
    const grounding = scenario("grounding-later");
    const [question] = askWith(
      1,
      GROUNDING_QUESTION,
      GROUNDING_OPTIONS,
    ).questions;
    const asked = question ?? panic("the helper builds one question");
    expect(grounding.answer(asked, [])).toBe("Start without them for now.");
    expect(grounding.answer(asked, [event(1, "save_playbook")])).toBe(
      "Yes, look in my matters.",
    );
  });

  test("a grounding question that names no contracts still gets the yes", () => {
    const [question] = askWith(
      1,
      "How should I finish grounding the playbook?",
      GROUNDING_OPTIONS,
    ).questions;
    expect(
      scenario("grounding-later").answer(
        question ?? panic("the helper builds one question"),
        [event(1, "save_playbook")],
      ),
    ).toBe("Yes, look in my matters.");
  });

  test("offering to ground in prose instead of asking is a defect", () => {
    const events = groundingLaterRun().slice(0, 3);
    expect(
      score("grounding-later", events, playbook(undefined), [
        "The positions are saved. If you want, I can ground them in your contracts.",
      ]),
    ).toEqual([
      "ended turn 1 with an offer: If you want, I can ground them in your contracts.",
      "did not ask with ask-user whether to ground the saved positions in contracts",
    ]);
  });

  test("asking which matters without listing them first is a defect", () => {
    const events = groundingLaterRun().filter(
      ({ name }) => name !== "list_matters",
    );
    expect(score("grounding-later", events)).toEqual([
      "asked which matters before listing them",
    ]);
  });

  test("offering candidates before listing the matter is a defect", () => {
    const events = groundingLaterRun();
    const [listing] = events.splice(6, 1);
    events.splice(7, 0, listing ?? panic("the run lists the documents"));
    expect(score("grounding-later", events)).toEqual([
      "offered candidates before listing the chosen matter's documents",
    ]);
  });
});

describe("shared scoring", () => {
  test("a side option that merges role pairs is a defect", () => {
    const events = contractsLaterRun();
    events[0] = askWith(1, "Which side is your organization on?", [
      "Customer / recipient / buyer",
      "Supplier",
    ]);
    expect(score("contracts-later", events)).toContain(
      "offered a side option that merges role pairs: Customer / recipient / buyer",
    );
  });

  test("a role described in plain words is not a merged option", () => {
    const events = contractsLaterRun();
    events[0] = askWith(1, "Which side is your organization on?", [
      "Customer (receiving IT services)",
      "Supplier (providing IT services)",
    ]);
    expect(
      score("contracts-later", events).filter((defect) =>
        defect.includes("merges role pairs"),
      ),
    ).toEqual([]);
  });

  test("looking for starter playbooks is a defect", () => {
    const events = contractsLaterRun();
    events.splice(1, 0, event(1, "list_templates"));
    expect(score("contracts-later", events)).toEqual([
      "looked for starter playbooks with list_templates",
    ]);
  });

  test("a turn that saves nothing after the opening answers is a stall", () => {
    const events = contractsLaterRun().filter(
      ({ name, turn }) => turn !== 1 || name !== "save_playbook",
    );
    expect(score("contracts-later", events)).toEqual([
      "saved nothing in the turn that received the opening answers",
    ]);
  });

  test("a reply that ends on a statement or a pointer is not an offer", () => {
    expect(
      score("contracts-later", contractsLaterRun(), playbook(undefined), [
        "Saved the first positions.",
        "If you prefer a starter instead, an MSA starter is available on the playbooks page.",
      ]),
    ).toEqual([]);
  });

  test("a reply that ends on a first-person offer is a stall", () => {
    expect(
      score("contracts-later", contractsLaterRun(), playbook(undefined), [
        "Next, I can keep building the playbook with the main supplier terms.",
      ]),
    ).toEqual([
      "ended turn 1 with an offer: Next, I can keep building the playbook with the main supplier terms.",
    ]);
  });
});
