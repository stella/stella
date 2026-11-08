import { describe, expect, test } from "bun:test";

import {
  chatLocalRunAnswersRefusal,
  type ChatLocalRunQuestion,
} from "@stll/api-contract/chat-run-target";
import { DESKTOP_RUNNER_ANSWER_LIMITS } from "@stll/api-contract/desktop-runner";

import {
  canSubmitLocalRunAnswers,
  EMPTY_LOCAL_RUN_QUESTION_DRAFT,
  localRunAnswersOf,
  localRunQuestionCallId,
  type LocalRunQuestionDraft,
  localRunQuestionPauseOf,
  toggleLocalRunOption,
} from "@/components/chat/local-run-question.logic";

const governingLaw = {
  id: "law",
  header: "Governing law",
  prompt: "Which law governs the lease?",
  options: [
    { label: "Czech", description: "Czech Civil Code" },
    { label: "Slovak", description: "Slovak Civil Code" },
  ],
  allowsFreeText: false,
  multiSelect: false,
  secret: false,
} as const satisfies ChatLocalRunQuestion;
const signatories = {
  id: "parties",
  header: "Signatories",
  prompt: "Who signs?",
  options: [
    { label: "Lessor", description: "" },
    { label: "Lessee", description: "" },
  ],
  allowsFreeText: true,
  multiSelect: true,
  secret: false,
} as const satisfies ChatLocalRunQuestion;
const passphrase = {
  id: "passphrase",
  header: "Passphrase",
  prompt: "The archive passphrase?",
  options: [],
  allowsFreeText: true,
  multiSelect: false,
  secret: true,
} as const satisfies ChatLocalRunQuestion;
const questions = [governingLaw, signatories, passphrase];

const questionInterrupt = (metadataQuestions: unknown) => ({
  id: "00000000-0000-7000-8000-0000000000a1",
  reason: "user_input",
  metadata: {
    kind: "question",
    toolName: "request_user_input",
    questions: metadataQuestions,
  },
});

describe("a local run's question pause", () => {
  test("is read from the turn's user-input interrupt", () => {
    expect(
      localRunQuestionPauseOf([
        {
          id: "approval-1",
          reason: "tool_call",
          metadata: { kind: "approval", toolName: "command_execution" },
        },
        questionInterrupt(structuredClone(questions)),
      ]),
    ).toEqual({
      interruptId: "00000000-0000-7000-8000-0000000000a1",
      questions,
    });
  });

  test("is absent without a question, or with questions an answer cannot be checked against", () => {
    const cases: [string, Parameters<typeof localRunQuestionPauseOf>[0]][] = [
      ["no interrupts", []],
      [
        "an approval",
        [{ id: "a", reason: "tool_call", metadata: { kind: "approval" } }],
      ],
      ["no questions", [questionInterrupt([])]],
      ["a malformed question", [questionInterrupt([{ id: "law" }])]],
      [
        "questions without a multiple-choice flag",
        [
          questionInterrupt([
            Object.fromEntries(
              Object.entries(governingLaw).filter(
                ([key]) => key !== "multiSelect",
              ),
            ),
          ]),
        ],
      ],
    ];
    for (const [name, interrupts] of cases) {
      expect({ name, pause: localRunQuestionPauseOf(interrupts) }).toEqual({
        name,
        pause: null,
      });
    }
  });

  test("belongs to the message's open question call, not an answered one", () => {
    expect(
      localRunQuestionCallId([
        { type: "text" },
        {
          type: "tool-call",
          id: "answered",
          name: "request_user_input",
          state: "complete",
        },
        {
          type: "tool-call",
          id: "command",
          name: "command_execution",
          state: "input-complete",
        },
        {
          type: "tool-call",
          id: "open",
          name: "request_user_input",
          state: "input-complete",
        },
      ]),
    ).toBe("open");
    expect(
      localRunQuestionCallId([
        {
          type: "tool-call",
          id: "answered",
          name: "request_user_input",
          state: "complete",
        },
      ]),
    ).toBeNull();
  });
});

describe("answers to a local run's question", () => {
  const drafts = (
    entries: Record<string, Partial<LocalRunQuestionDraft>>,
  ): Record<string, LocalRunQuestionDraft> =>
    Object.fromEntries(
      Object.entries(entries).map(([id, draft]) => [
        id,
        { ...EMPTY_LOCAL_RUN_QUESTION_DRAFT, ...draft },
      ]),
    );

  test("a single choice keeps one option; a multiple choice keeps each picked", () => {
    let law = EMPTY_LOCAL_RUN_QUESTION_DRAFT;
    law = toggleLocalRunOption(governingLaw, law, "Czech");
    law = toggleLocalRunOption(governingLaw, law, "Slovak");
    expect(law.picked).toEqual(["Slovak"]);
    let parties = EMPTY_LOCAL_RUN_QUESTION_DRAFT;
    parties = toggleLocalRunOption(signatories, parties, "Lessor");
    parties = toggleLocalRunOption(signatories, parties, "Lessee");
    expect(parties.picked).toEqual(["Lessor", "Lessee"]);
    expect(toggleLocalRunOption(signatories, parties, "Lessor").picked).toEqual(
      ["Lessee"],
    );
  });

  test("are keyed by question id: the options picked, or the member's own words", () => {
    expect(
      localRunAnswersOf(
        questions,
        drafts({
          law: { picked: ["Czech"] },
          parties: {
            picked: ["Lessor"],
            text: "  Guarantor  ",
            ownWords: true,
          },
          passphrase: { text: " open sesame " },
        }),
      ),
    ).toEqual({
      law: ["Czech"],
      parties: ["Guarantor"],
      // A secret is sent exactly as typed.
      passphrase: [" open sesame "],
    });
  });

  test("blank words and nothing picked are no answer", () => {
    expect(
      localRunAnswersOf(
        questions,
        drafts({ parties: { text: "   ", ownWords: true } }),
      ),
    ).toEqual({ law: [], parties: [], passphrase: [] });
  });

  test("own words count only where the question takes them", () => {
    expect(
      localRunAnswersOf(
        [governingLaw],
        drafts({
          law: { picked: ["Czech"], text: "Austrian", ownWords: true },
        }),
      ),
    ).toEqual({ law: ["Czech"] });
  });

  test("an answer past the length the server reads is not offered", () => {
    const answers = (text: string) =>
      drafts({
        law: { picked: ["Czech"] },
        parties: { picked: ["Lessor", "Lessee"] },
        passphrase: { text },
      });
    expect(
      canSubmitLocalRunAnswers(
        questions,
        answers("x".repeat(DESKTOP_RUNNER_ANSWER_LIMITS.maxAnswerLength)),
      ),
    ).toBe(true);
    expect(
      canSubmitLocalRunAnswers(
        questions,
        answers("x".repeat(DESKTOP_RUNNER_ANSWER_LIMITS.maxAnswerLength + 1)),
      ),
    ).toBe(false);
  });

  test("are offered for sending exactly when the server's rule accepts them", () => {
    const cases: Record<string, LocalRunQuestionDraft>[] = [
      {},
      drafts({ law: { picked: ["Czech"] } }),
      drafts({
        law: { picked: ["Czech"] },
        parties: { picked: ["Lessor", "Lessee"] },
        passphrase: { text: "x" },
      }),
      drafts({
        law: { picked: ["Czech"] },
        parties: { text: "Guarantor", ownWords: true },
        passphrase: { text: " " },
      }),
    ];
    const verdicts = cases.map((entry) => ({
      offered: canSubmitLocalRunAnswers(questions, entry),
      accepted:
        chatLocalRunAnswersRefusal(
          questions,
          localRunAnswersOf(questions, entry),
        ) === null,
    }));
    for (const verdict of verdicts) {
      expect(verdict.offered).toBe(verdict.accepted);
    }
    expect(verdicts.map(({ offered }) => offered)).toEqual([
      false,
      false,
      true,
      false,
    ]);
  });
});
