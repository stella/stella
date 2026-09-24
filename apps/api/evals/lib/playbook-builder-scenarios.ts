/**
 * Scenarios for the playbook-authoring eval's behavior tier: the matters and
 * contracts a run can find, the user's scripted answers, and what each
 * scenario checks in the run's evidence.
 *
 * The oracle is the stored playbook, the questions asked, and the shape and
 * order of the calls, never the model's prose.
 */

import type { RegistryReadToolDataByName } from "@/api/handlers/chat/tools/registry-adapter/run-registry-tool";
import { SPAWN_SUBAGENTS_TOOL_NAME } from "@/api/handlers/chat/tools/subagent-tool-shared";
import { attachmentText } from "@/api/handlers/chat/upload-files";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  PlaybookScope,
  Position,
} from "@/api/lib/workflow/playbook-positions";
import type { InternalToolResult } from "@/api/mcp/tool-types";
import { structuredErrorResult } from "@/api/mcp/tool-utils";

import { classifyQuestion, isCzech } from "./playbook-builder-score";
import type { QuestionTopic } from "./playbook-builder-score";
import type { StoredPlaybook } from "./playbook-store";

export const MATTER_TOOL_NAMES = [
  "list_matters",
  "list_documents",
  "search_across_matters",
  "read_content_across_matters",
] as const;

export type MatterToolName = (typeof MATTER_TOOL_NAMES)[number];

export const isMatterToolName = (name: string): name is MatterToolName =>
  MATTER_TOOL_NAMES.some((matterTool) => matterTool === name);

/**
 * How the matter reads reach the model. `mcp` hands them over as direct
 * tools with their production schemas, as an MCP client is served them.
 * `chat` is the stella chat surface: the reads are `external_*` functions
 * inside `execute_typescript`; `list_matters` and the reads the skill
 * documents are documented up front, and the rest are reached through
 * `discover_tools`.
 */
export const BUILDER_SURFACES = ["mcp", "chat"] as const;

export type BuilderSurface = (typeof BUILDER_SURFACES)[number];

export const EXECUTE_TYPESCRIPT = "execute_typescript";
export const DISCOVER_TOOLS = "discover_tools";

export type AskedQuestion = {
  question: string;
  reason: string;
  options: readonly string[];
  default: string | undefined;
};

/**
 * One call a run made, in order. `questions` is set on an `ask-user` call.
 * On the chat surface a matter read inside a script is its own event, named
 * by its registry name and placed after the `execute_typescript` event that
 * ran it; `input` is what the handler saw, so a ref has become its id.
 */
export type BuilderEvent = {
  name: string;
  input: unknown;
  /** Which user message the call answered: 1 for the brief, then one per
   *  follow-up. */
  turn: number;
  questions: readonly AskedQuestion[];
  /** Issues a save named by `source_id` and left unchanged. */
  resentUnchanged: readonly string[];
  /** The refusal or failure the call was answered with, if any. */
  error: string | null;
};

type BuilderEvidence = {
  surface: BuilderSurface;
  /** Reads the active skill documents up front on the chat surface. */
  documentedReads: ReadonlySet<string>;
  events: readonly BuilderEvent[];
  playbooks: readonly StoredPlaybook[];
};

type PlaybookPerspective = NonNullable<PlaybookScope["perspective"]>;

export type BuilderScenario = {
  id: string;
  brief: string;
  /** User messages sent one per later turn, each once the turn before ended,
   *  with the whole conversation so far as history. */
  followUps: readonly string[];
  /** The `scope.perspective` values the user's side maps to; `undefined`
   *  is the omission the skill asks for when the side maps to none. */
  perspectives: readonly (PlaybookPerspective | undefined)[];
  answer: (question: AskedQuestion) => string;
  check: (evidence: BuilderEvidence) => string[];
};

// --- the organization's matters -------------------------------------------

const SUPPLY_MATTER = {
  id: toSafeId<"workspace">("5d1f0a4e-6c2b-4e8a-9f3d-1a2b3c4d5e01"),
  name: "Nordwind Logistik: supplier contracts",
  reference: "NWL-2024-017",
};
const DISPUTE_MATTER = {
  id: toSafeId<"workspace">("5d1f0a4e-6c2b-4e8a-9f3d-1a2b3c4d5e02"),
  name: "Harbour Co v Nordwind (dispute)",
  reference: "NWL-2025-003",
};
const MATTERS = [SUPPLY_MATTER, DISPUTE_MATTER];
const MATTER_TIMESTAMP = "2026-08-20T09:00:00.000Z";

type FixtureDocument = {
  id: SafeId<"entity">;
  matterId: SafeId<"workspace">;
  name: string;
  text: string;
};

const servicesAgreement = ({
  supplier,
  cap,
  payment,
  status,
}: {
  supplier: string;
  cap: string;
  payment: string;
  status: string;
}) =>
  [
    `SERVICES AGREEMENT between Nordwind Logistik GmbH (Customer) and ${supplier} (Supplier). ${status}`,
    "1. Services. The Supplier provides warehouse management software services as described in Schedule 1.",
    `2. Fees and payment. Invoices are payable within ${payment} of receipt.`,
    `3. Liability. ${cap}`,
    "4. Term. The agreement runs for an initial term of 24 months and renews for 12 months unless terminated on 3 months' notice.",
    "5. Governing law. This agreement is governed by the laws of the Federal Republic of Germany. Courts of Hamburg have exclusive jurisdiction.",
    "6. Data protection. The parties conclude a data processing agreement under Article 28 GDPR.",
  ].join("\n\n");

const KELLER = {
  id: toSafeId<"entity">("7a0c1e2f-3b4d-4c5e-8f6a-7b8c9d0e1f01"),
  matterId: SUPPLY_MATTER.id,
  name: "Services Agreement Nordwind - Keller GmbH (signed 2025-03-14).pdf",
  text: servicesAgreement({
    supplier: "Keller GmbH",
    cap: "Each party's total liability is capped at the fees paid in the 12 months before the claim. The cap does not apply to intent or gross negligence.",
    payment: "30 days",
    status: "Signed by both parties on 14 March 2025.",
  }),
};
const BRANDT = {
  id: toSafeId<"entity">("7a0c1e2f-3b4d-4c5e-8f6a-7b8c9d0e1f02"),
  matterId: SUPPLY_MATTER.id,
  name: "Services Agreement Nordwind - Brandt AG (executed).docx",
  text: servicesAgreement({
    supplier: "Brandt AG",
    cap: "Total liability of either party is limited to the fees paid in the 12 months preceding the event giving rise to the claim, except for intent and gross negligence.",
    payment: "30 days",
    status: "Executed on 2 September 2025.",
  }),
};
// Counterparty paper, not executed: the confirmation question exists so the
// user can keep this out of the playbook.
const VOGEL_DRAFT = {
  id: toSafeId<"entity">("7a0c1e2f-3b4d-4c5e-8f6a-7b8c9d0e1f03"),
  matterId: SUPPLY_MATTER.id,
  name: "Services Agreement Nordwind - Vogel (DRAFT v3, supplier markup).docx",
  text: servicesAgreement({
    supplier: "Vogel Systems GmbH",
    cap: "The Supplier's total liability is capped at EUR 10,000.",
    payment: "10 days",
    status: "DRAFT v3 with the supplier's markup; not signed.",
  }),
};
// Executed, but in a matter the user did not name.
const HARBOUR = {
  id: toSafeId<"entity">("7a0c1e2f-3b4d-4c5e-8f6a-7b8c9d0e1f04"),
  matterId: DISPUTE_MATTER.id,
  name: "Services Agreement Nordwind - Harbour Co (executed).pdf",
  text: servicesAgreement({
    supplier: "Harbour Co Ltd",
    cap: "Liability is uncapped.",
    payment: "45 days",
    status: "Executed on 1 June 2024.",
  }),
};
const DOCUMENTS: readonly FixtureDocument[] = [
  KELLER,
  BRANDT,
  VOGEL_DRAFT,
  HARBOUR,
];

const matterOf = (matterId: string) =>
  MATTERS.find(({ id }) => id === matterId);

const stringArg = (input: unknown, key: string): string | undefined => {
  if (typeof input !== "object" || input === null || !(key in input)) {
    return undefined;
  }
  const value: unknown = Reflect.get(input, key);
  return typeof value === "string" ? value : undefined;
};

const success = <TData>(data: TData): InternalToolResult<TData> => ({
  status: "success",
  data,
});

/**
 * The matter reads answered from the fixtures. Each answer is typed as the
 * production handler's own data, so a fixture cannot drift from the shape a
 * handler returns and the chat projection strict-parses.
 */
type MatterFixtures = {
  [TName in MatterToolName]: (
    args: Record<string, unknown>,
  ) => InternalToolResult<RegistryReadToolDataByName[TName]>;
};

const MATTER_FIXTURES: MatterFixtures = {
  list_matters: () =>
    success({
      matters: MATTERS.map(({ id, name, reference }) => ({
        id,
        name,
        reference,
        status: "active",
        lastActivityAt: MATTER_TIMESTAMP,
        createdAt: MATTER_TIMESTAMP,
      })),
      nextCursor: null,
    }),
  list_documents: (args) => {
    const matterId = stringArg(args, "matter_id");
    return success({
      documents: DOCUMENTS.filter((doc) => doc.matterId === matterId).map(
        ({ id, name }) => ({ id, name, kind: "document", parentId: null }),
      ),
      nextCursor: null,
    });
  },
  search_across_matters: (args) => {
    const words = (stringArg(args, "query") ?? "")
      .toLowerCase()
      .split(/\W+/u)
      .filter((word) => word.length > 2);
    const hits = DOCUMENTS.filter((doc) =>
      words.some((word) =>
        `${doc.name} ${doc.text}`.toLowerCase().includes(word),
      ),
    );
    return success({
      totalCount: hits.length,
      nextCursor: null,
      hits: hits.map((doc) => ({
        entityId: doc.id,
        workspaceId: doc.matterId,
        workspaceName: matterOf(doc.matterId)?.name ?? "",
        name: doc.name,
        kind: "document",
        headline: doc.text.slice(0, 160),
      })),
    });
  },
  read_content_across_matters: (args) => {
    const doc = DOCUMENTS.find(({ id }) => id === stringArg(args, "entity_id"));
    if (doc === undefined) {
      return structuredErrorResult({
        code: "not_found",
        message: "No such document",
      });
    }
    return success({
      charCount: doc.text.length,
      entityId: doc.id,
      kind: "document",
      name: doc.name,
      text: doc.text,
      truncated: false,
      nextCursor: null,
      workspaceId: doc.matterId,
    });
  },
};

/** Answers a matter read from the fixtures, as its handler would. */
export const answerMatterTool = (
  name: MatterToolName,
  args: Record<string, unknown>,
): InternalToolResult => MATTER_FIXTURES[name](args);

// --- evidence readers -----------------------------------------------------

const RECOMMENDATION = "Use your recommendation.";

const fallbackAnswer = (question: AskedQuestion): string =>
  question.default ?? question.options.at(0) ?? RECOMMENDATION;

/** The script's answer for each topic; a question with none gets a default. */
const answerByTopic =
  (answers: Record<QuestionTopic, string>) =>
  (question: AskedQuestion): string => {
    const topic = classifyQuestion(question.question);
    return topic === null ? fallbackAnswer(question) : answers[topic];
  };

const questionText = ({ question, reason, options }: AskedQuestion) =>
  [question, reason, ...options].join(" ");

const askedQuestions = (events: readonly BuilderEvent[]) =>
  events.flatMap(({ questions }) => questions);

const indexOfFirst = (
  events: readonly BuilderEvent[],
  predicate: (event: BuilderEvent) => boolean,
): number => {
  const index = events.findIndex(predicate);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
};

const isSave = ({ name }: BuilderEvent) => name === "save_playbook";

/** Positions a save call carries; the skill saves one per call. */
const positionCount = (input: unknown): number => {
  if (typeof input !== "object" || input === null || !("positions" in input)) {
    return 0;
  }
  const positions: unknown = Reflect.get(input, "positions");
  return Array.isArray(positions) ? positions.length : 0;
};

const topicsAskedBeforeFirstSave = (events: readonly BuilderEvent[]) => {
  const firstSave = indexOfFirst(events, isSave);
  return new Set(
    askedQuestions(events.slice(0, firstSave)).map(({ question }) =>
      classifyQuestion(question),
    ),
  );
};

const missingTopics = (
  events: readonly BuilderEvent[],
  topics: readonly QuestionTopic[],
): string[] => {
  const asked = topicsAskedBeforeFirstSave(events);
  return topics
    .filter((topic) => !asked.has(topic))
    .map((topic) => `did not ask about ${topic} before the first save`);
};

const matterCalls = (events: readonly BuilderEvent[]) =>
  events.filter(({ name }) => isMatterToolName(name));

const eventsOfTurn = (events: readonly BuilderEvent[], turn: number) =>
  events.filter((event) => event.turn === turn);

/** A named matter is read with `list_documents`, never with a search. */
const namedMatterDefects = (events: readonly BuilderEvent[]): string[] => {
  const defects: string[] = [];
  if (events.some(({ name }) => name === "search_across_matters")) {
    defects.push("searched across every matter although the user named one");
  }
  // A refused call listed nothing, and its input still holds the ref the
  // script wrote rather than the matter id; it is charged as a failure by
  // `commonDefects`, not here.
  const otherMatters = events.filter(
    ({ name, input, error }) =>
      name === "list_documents" &&
      error === null &&
      stringArg(input, "matter_id") !== SUPPLY_MATTER.id,
  );
  if (otherMatters.length > 0) {
    defects.push("listed documents outside the named matter");
  }
  return defects;
};

const discoveredNames = (input: unknown): string[] => {
  const names =
    typeof input === "object" && input !== null && "toolNames" in input
      ? input.toolNames
      : undefined;
  return Array.isArray(names)
    ? names.filter((name): name is string => typeof name === "string")
    : [];
};

/**
 * On the chat surface a read that neither the base prompt (`list_matters`)
 * nor the skill documents is documented only by `discover_tools`; a call
 * written without its signature is a guess, whether or not it happened to
 * work. The rule keeps guarding every matter read a skill does not declare.
 */
const readsBeforeDiscovery = ({
  documentedReads,
  events,
}: Pick<BuilderEvidence, "documentedReads" | "events">): string[] => {
  const discovered = new Set<string>(["list_matters", ...documentedReads]);
  const defects: string[] = [];
  for (const { name, input } of events) {
    if (name === DISCOVER_TOOLS) {
      for (const discoveredName of discoveredNames(input)) {
        discovered.add(discoveredName.replace(/^external_/u, ""));
      }
      continue;
    }
    if (isMatterToolName(name) && !discovered.has(name)) {
      defects.push(`called ${name} before discover_tools named it`);
      discovered.add(name);
    }
  }
  return defects;
};

const readDocumentIds = (events: readonly BuilderEvent[]) =>
  new Set(
    events
      .filter(({ name }) => name === "read_content_across_matters")
      .map(({ input }) => stringArg(input, "entity_id")),
  );

const tierTexts = (position: Position): string[] => {
  if (position.mode !== "graded" || position.standard.source !== "tiers") {
    return [];
  }
  const { acceptable, fallback, notAcceptable } = position.standard.tiers;
  return [
    ...acceptable.rules.map(({ text }) => text),
    ...fallback.entries.map(({ text }) => text),
    ...notAcceptable.rules.map(({ text }) => text),
  ];
};

/**
 * Defects every scenario shares: one playbook, enough positions, no resends,
 * no matter read or script refused, no work handed to subagents, and on the
 * chat surface no read written before its signature was discovered.
 */
const commonDefects = ({
  documentedReads,
  events,
  playbooks,
  surface,
}: BuilderEvidence): string[] => {
  const defects: string[] = [];
  for (const { name, error } of events) {
    if (
      error !== null &&
      (isMatterToolName(name) || name === EXECUTE_TYPESCRIPT)
    ) {
      defects.push(`${name} failed: ${error}`);
    }
  }
  if (surface === "chat") {
    defects.push(...readsBeforeDiscovery({ documentedReads, events }));
  }
  const spawned = events.filter(
    ({ name }) => name === SPAWN_SUBAGENTS_TOOL_NAME,
  ).length;
  if (spawned > 0) {
    defects.push(`handed work to subagents ${String(spawned)} time(s)`);
  }
  if (playbooks.length !== 1) {
    defects.push(`${String(playbooks.length)} playbooks stored; expected one`);
  }
  const positions = playbooks.at(0)?.positions.items ?? [];
  if (positions.filter(({ mode }) => mode === "graded").length < 3) {
    defects.push("fewer than three graded positions were saved");
  }
  const resent = events.flatMap(({ resentUnchanged }) => resentUnchanged);
  if (resent.length > 0) {
    defects.push(`resent unchanged positions: ${resent.join(", ")}`);
  }
  for (const save of events.filter(isSave)) {
    const count = positionCount(save.input);
    if (count > 1) {
      defects.push(`saved ${String(count)} positions in one call`);
    }
  }
  return defects;
};

/**
 * `scope.perspective` is set only when the side maps to a value it has; a
 * recipient saved as `neutral` is a wrong reading, not a default.
 */
const perspectiveDefects = (
  playbooks: readonly StoredPlaybook[],
  perspectives: readonly (PlaybookPerspective | undefined)[],
): string[] =>
  playbooks
    .map(({ scope }) => scope?.perspective)
    .filter((perspective) => !perspectives.includes(perspective))
    .map(
      (perspective) =>
        `saved scope.perspective ${String(perspective)}; the side maps to ${perspectives.map(String).join(" or ")}`,
    );

/** Every defect of a run: the shared checks, then the scenario's own. */
export const scoreScenario = (
  scenario: BuilderScenario,
  evidence: BuilderEvidence,
): string[] => [
  ...commonDefects(evidence),
  ...perspectiveDefects(evidence.playbooks, scenario.perspectives),
  ...scenario.check(evidence),
];

// --- scenarios ------------------------------------------------------------

const noDocuments: BuilderScenario = {
  id: "no-documents",
  brief: "Help me build a playbook for reviewing NDAs.",
  followUps: [],
  perspectives: [undefined],
  answer: answerByTopic({
    contracts: "No, I have none to share. Start without them.",
    language: "Czech.",
    law: "Czech law.",
    matters: "None. Start without contracts.",
    side: "We are the receiving party.",
    type: "Mutual and one-way NDAs we receive from business partners.",
  }),
  check: (evidence) => {
    const defects = missingTopics(evidence.events, [
      "contracts",
      "side",
      "law",
      "language",
    ]);
    const searched = matterCalls(evidence.events);
    if (searched.length > 0) {
      defects.push(
        `called ${searched.map(({ name }) => name).join(", ")} after the user declined contracts`,
      );
    }
    const positions = evidence.playbooks.at(0)?.positions.items ?? [];
    const czech = positions.filter((position) =>
      isCzech([position.issue, ...tierTexts(position)].join(" ")),
    );
    if (czech.length * 2 < positions.length) {
      defects.push(
        `${String(czech.length)} of ${String(positions.length)} positions are in Czech`,
      );
    }
    return defects;
  },
};

const CONFIRMED_DOCUMENTS = [KELLER, BRANDT];
const CONFIRMED_MARKERS = ["Keller", "Brandt"];
const CANDIDATE_MARKERS = [...CONFIRMED_MARKERS, "Vogel", "Harbour"];

const isCandidatesQuestion = (question: AskedQuestion) =>
  CANDIDATE_MARKERS.some((marker) => questionText(question).includes(marker));

/** Picks the two executed agreements from the candidates offered. */
const pickConfirmedCandidates = (question: AskedQuestion): string => {
  const picked = question.options.filter((option) =>
    CONFIRMED_MARKERS.some((marker) => option.includes(marker)),
  );
  return picked.length > 0
    ? picked.join(", ")
    : "Use the Keller GmbH and Brandt AG agreements; the Vogel one is only a draft.";
};

/**
 * The candidates were offered before any read, only the picked documents
 * were read, and all of them were.
 */
const confirmedReadDefects = (events: readonly BuilderEvent[]): string[] => {
  const defects: string[] = [];
  const firstRead = indexOfFirst(
    events,
    ({ name }) => name === "read_content_across_matters",
  );
  const firstCandidates = indexOfFirst(events, ({ questions }) =>
    questions.some(isCandidatesQuestion),
  );
  if (firstCandidates > firstRead) {
    defects.push("read a contract before the user confirmed the candidates");
  }
  const read = readDocumentIds(events);
  const unconfirmed = DOCUMENTS.filter(
    ({ id }) =>
      read.has(id) && !CONFIRMED_DOCUMENTS.some((doc) => doc.id === id),
  );
  if (unconfirmed.length > 0) {
    defects.push(
      `read unconfirmed documents: ${unconfirmed.map(({ name }) => name).join(", ")}`,
    );
  }
  if (!CONFIRMED_DOCUMENTS.every(({ id }) => read.has(id))) {
    defects.push("did not read every confirmed contract");
  }
  return defects;
};

/** Both executed agreements cap liability at 12 months of fees. */
const liabilityGroundingDefects = (
  playbooks: readonly StoredPlaybook[],
): string[] => {
  const positions = playbooks.at(0)?.positions.items ?? [];
  const liability = positions.find(({ issue }) => /liabilit/iu.test(issue));
  return liability !== undefined &&
    tierTexts(liability).some((text) => text.includes("12"))
    ? []
    : ["no liability position grounded in the contracts' 12-month cap"];
};

const answerDiscoveryTopic = answerByTopic({
  contracts: `Yes, please look for them in the "${SUPPLY_MATTER.name}" matter.`,
  language: "English.",
  law: "German law.",
  matters: `The "${SUPPLY_MATTER.name}" matter.`,
  side: "We are the customer.",
  type: "IT services agreements with software suppliers.",
});

const discovery: BuilderScenario = {
  id: "discovery",
  brief:
    "I want a playbook for the IT services agreements we sign with our suppliers.",
  followUps: [],
  perspectives: [undefined],
  answer: (question) =>
    isCandidatesQuestion(question)
      ? pickConfirmedCandidates(question)
      : answerDiscoveryTopic(question),
  check: ({ events, playbooks }) => {
    const defects = missingTopics(events, ["contracts", "side", "law"]);
    const firstMatterCall = indexOfFirst(
      events,
      (event) => matterCalls([event]).length > 0,
    );
    const firstContractsQuestion = indexOfFirst(events, ({ questions }) =>
      questions.some(
        ({ question }) => classifyQuestion(question) === "contracts",
      ),
    );
    if (firstMatterCall < firstContractsQuestion) {
      defects.push("searched matters before the user agreed");
    }
    defects.push(
      ...namedMatterDefects(events),
      ...confirmedReadDefects(events),
      ...liabilityGroundingDefects(playbooks),
    );
    return defects;
  },
};

const answerContractsLaterTopic = answerByTopic({
  contracts: "Not now. Start from defaults and the interview.",
  language: "English.",
  law: "German law.",
  matters: `The "${SUPPLY_MATTER.name}" matter.`,
  side: "We are the customer.",
  type: "IT services agreements with software suppliers.",
});

/**
 * The user declines contracts, lets the first positions land, then asks for
 * their matters mid-flow. The switch re-enters "Look for them" at its first
 * step: ask which matters, list the named one, offer the candidates, read
 * only the picks; never a search across every matter, never subagents.
 */
const contractsLater: BuilderScenario = {
  id: "contracts-later",
  brief:
    "I want a playbook for the IT services agreements we sign with our suppliers.",
  followUps: [
    "Use the existing contracts in my matters to inform the remaining positions.",
  ],
  perspectives: [undefined],
  answer: (question) =>
    isCandidatesQuestion(question)
      ? pickConfirmedCandidates(question)
      : answerContractsLaterTopic(question),
  check: ({ events, playbooks }) => {
    const defects = missingTopics(events, ["contracts", "side", "law"]);
    const opening = eventsOfTurn(events, 1);
    if (matterCalls(opening).length > 0) {
      defects.push("looked for contracts after the user declined them");
    }
    if (!opening.some(isSave)) {
      defects.push("saved nothing before the user asked for contracts");
    }
    const later = eventsOfTurn(events, 2);
    const firstMattersQuestion = indexOfFirst(later, ({ questions }) =>
      questions.some(
        ({ question }) => classifyQuestion(question) === "matters",
      ),
    );
    const firstLookup = indexOfFirst(
      later,
      ({ name }) => isMatterToolName(name) && name !== "list_matters",
    );
    if (firstMattersQuestion === Number.POSITIVE_INFINITY) {
      defects.push("did not ask which matters to search");
    } else if (firstLookup < firstMattersQuestion) {
      defects.push("looked in matters before asking which ones");
    }
    if (!later.some(isSave)) {
      defects.push("saved nothing after the user asked for contracts");
    }
    defects.push(
      ...namedMatterDefects(later),
      ...confirmedReadDefects(later),
      ...liabilityGroundingDefects(playbooks),
    );
    return defects;
  },
};

const dpa = ({
  processor,
  liability,
}: {
  processor: string;
  liability: string;
}) =>
  [
    `DATA PROCESSING AGREEMENT between Nordwind Logistik GmbH (Controller) and ${processor} (Processor). Executed.`,
    "1. Subject matter. The Processor processes personal data of the Controller's employees and customers only on documented instructions.",
    "2. Personal data breaches. The Processor notifies the Controller of a personal data breach without undue delay and in any event within 48 hours of becoming aware of it.",
    "3. Sub-processors. The Processor engages a new sub-processor only after 30 days' prior written notice, during which the Controller may object.",
    "4. Audits. The Controller may audit the Processor once a year on 30 days' notice.",
    `5. Liability. ${liability}`,
    "6. Governing law. This agreement is governed by the laws of the Netherlands.",
  ].join("\n\n");

const answerDpaTopic = answerByTopic({
  contracts: "Only the two I attached.",
  language: "English.",
  law: "Dutch law.",
  matters: "None. Use only the two I attached.",
  side: "We are the controller.",
  type: "Data processing agreements under Article 28 GDPR.",
});

const withDocuments: BuilderScenario = {
  id: "with-documents",
  brief: [
    "Build a playbook for the data processing agreements we sign as controller, from these two executed DPAs. Write it in English.",
    "Non-standard breach notification terms go to our privacy counsel.",
    "",
    attachmentText({
      fileName: "DPA Nordwind - CloudStore BV (executed).docx",
      content: dpa({
        processor: "CloudStore BV",
        liability:
          "Each party's liability under this agreement is subject to the limitation of liability in the main services agreement.",
      }),
    }),
    "",
    attachmentText({
      fileName: "DPA Nordwind - Payroll Partners BV (executed).docx",
      content: dpa({
        processor: "Payroll Partners BV",
        liability:
          "The Processor's liability for breaches of this agreement or of data protection law is unlimited.",
      }),
    }),
  ].join("\n"),
  followUps: [],
  perspectives: [undefined],
  answer: (question) =>
    /liabilit/iu.test(questionText(question))
      ? "The processor's liability for its own data protection breaches may be unlimited; everything else falls under the main agreement's cap."
      : answerDpaTopic(question),
  check: ({ events, playbooks }) => {
    const defects: string[] = [];
    const searched = matterCalls(events);
    if (searched.length > 0) {
      defects.push(
        `looked for more contracts: ${searched.map(({ name }) => name).join(", ")}`,
      );
    }
    const asked = askedQuestions(events);
    if (!asked.some((question) => /liabilit/iu.test(questionText(question)))) {
      defects.push("did not ask about liability, where the DPAs disagree");
    }
    const agreed = asked
      .map(({ question }) => question)
      .filter((text) =>
        /breach notif|48 hours|sub-?processor|audit/iu.test(text),
      );
    if (agreed.length > 0) {
      defects.push(
        `asked where the DPAs agree: ${agreed.map((text) => text.slice(0, 80)).join(" | ")}`,
      );
    }
    const positions = playbooks.at(0)?.positions.items ?? [];
    const breach = positions.find(({ issue }) => /breach/iu.test(issue));
    const escalation =
      breach?.mode === "graded" ? (breach.negotiation?.escalation ?? "") : "";
    if (!/privacy counsel/iu.test(escalation)) {
      defects.push(
        "the privacy-counsel route is not in the breach position's escalation",
      );
    }
    if (
      positions.some((position) =>
        tierTexts(position).some((text) => /privacy counsel/iu.test(text)),
      )
    ) {
      defects.push("the privacy-counsel route landed in a tier rule");
    }
    return defects;
  },
};

export const BUILDER_SCENARIOS: readonly BuilderScenario[] = [
  noDocuments,
  discovery,
  contractsLater,
  withDocuments,
];
