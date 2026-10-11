import { expect, test } from "bun:test";

import { decide, decideMany } from "@/api/lib/workflow/decisions/decide";
import {
  choice,
  createSystemOneClient,
  noul,
} from "@/api/lib/workflow/decisions/system-one";

test.each([
  {
    question: noul("Read the required skill before answering."),
    answer: { type: "noul", noul: 1 },
  },
  {
    question: choice("Read the required skill before choosing.", {
      yes: null,
      no: null,
    }),
    answer: {
      type: "choice",
      choice: "yes",
      probabilities: { yes: 1, no: 0 },
      confidence: 1,
    },
  },
])(
  "tool-dependent $question.type questions bypass a confident decision model",
  async ({ question, answer }) => {
    let modelCalls = 0;
    let generationCalls = 0;
    const result = await decide({
      id: "test.required-tools",
      dataClass: "customer",
      orgAIConfig: null,
      state: "The answer depends on a referenced skill.",
      question: { ...question, requiredCapability: "tools" },
      client: {
        ...createSystemOneClient({
          apiKey: "test",
          fetcher: async () => {
            modelCalls += 1;
            return Response.json({
              model: "jev-test",
              answers: { answer },
              usage: { input_tokens: 1, output_tokens: 1 },
            });
          },
        }),
        keySource: "byok",
      },
      generator: async ({ questions }) => {
        generationCalls += 1;
        expect(questions.answer?.requiredCapability).toBe("tools");
        return {
          model: "fake-generative",
          output: { answers: [{ id: "answer", answer, evidence: null }] },
        };
      },
    });
    expect(modelCalls).toBe(0);
    expect(generationCalls).toBe(1);
    expect(result).toMatchObject({
      state: "decided",
      source: "generative",
      answer,
    });
  },
);

test("a mixed batch asks the decision model only about tool-free questions", async () => {
  let modelCalls = 0;
  const ordinary = noul("Is the contract signed?");
  const withTools = {
    ...noul("Does the skill permit this?"),
    requiredCapability: "tools",
  } as const;
  const result = await decideMany({
    id: "test.mixed-capabilities",
    dataClass: "customer",
    orgAIConfig: null,
    state: "The contract is signed.",
    questions: { ordinary, withTools },
    client: {
      ...createSystemOneClient({
        apiKey: "test",
        fetcher: async (_url, init) => {
          modelCalls += 1;
          expect(String(init?.body)).not.toContain(
            "Does the skill permit this?",
          );
          return Response.json({
            model: "jev-test",
            answers: { ordinary: { type: "noul", noul: 1 } },
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        },
      }),
      keySource: "byok",
    },
    generator: async ({ questions }) => {
      expect(questions).toEqual({ withTools });
      return {
        model: "fake-generative",
        output: {
          answers: [
            {
              id: "withTools",
              answer: { type: "noul", noul: 0 },
              evidence: null,
            },
          ],
        },
      };
    },
  });
  expect(modelCalls).toBe(1);
  expect(result.decisions.ordinary).toMatchObject({
    state: "decided",
    source: "decision-model",
  });
  expect(result.decisions.withTools).toMatchObject({
    state: "decided",
    source: "generative",
  });
});
