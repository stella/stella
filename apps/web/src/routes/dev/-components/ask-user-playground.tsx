import { AskUserCard } from "@/components/chat/ask-user-card";
import type {
  AskUserInput,
  RegisteredChatUIToolCallPart,
} from "@/components/chat/chat-ui-tools";

type AskUserPart = Extract<RegisteredChatUIToolCallPart, { name: "ask-user" }>;

const noop = () => undefined;

const MATTERS = [
  "Nordwind Logistik: supplier contracts",
  "Harbour Co v Nordwind",
  "Nordwind: employment",
];
const DOCUMENTS = [
  "Services Agreement Nordwind - Keller GmbH (signed 2025-03-14).pdf (Nordwind Logistik: supplier contracts)",
  "Services Agreement Nordwind - Brandt AG (executed).docx (Nordwind Logistik: supplier contracts)",
  "Services Agreement Nordwind - Vogel (DRAFT v3, supplier markup).docx (Nordwind Logistik: supplier contracts)",
];

const MATTERS_INPUT = {
  analysis:
    "The playbook can be grounded in contracts the organization signed.",
  questions: [
    {
      question: "Which matters should I search?",
      reason: "Only the matters you pick are searched.",
      options: MATTERS,
      selection: "multiple",
    },
    {
      question: "Which side is your organization on?",
      reason: "It decides which terms are favourable.",
      options: ["Customer", "Supplier"],
    },
  ],
} satisfies AskUserInput;

const DOCUMENTS_INPUT = {
  analysis: "These agreements are in the matter you picked.",
  questions: [
    {
      question: "Which documents should I read?",
      reason: "Only the documents you pick are read.",
      options: DOCUMENTS,
      selection: "multiple",
    },
  ],
} satisfies AskUserInput;

const pending = (id: string, input: AskUserInput): AskUserPart => ({
  arguments: JSON.stringify(input),
  id,
  input,
  name: "ask-user",
  state: "input-complete",
  type: "tool-call",
});

const CASES = [
  {
    id: "chips",
    part: pending("visual-ask-user-chips", MATTERS_INPUT),
  },
  {
    id: "list",
    part: pending("visual-ask-user-list", DOCUMENTS_INPUT),
  },
  {
    id: "answered",
    part: {
      ...pending("visual-ask-user-answered", DOCUMENTS_INPUT),
      output: {
        answers: [
          {
            question: "Which documents should I read?",
            selected: DOCUMENTS.slice(0, 2),
          },
        ],
      },
      state: "complete",
    },
  },
] satisfies { id: string; part: AskUserPart }[];

/** The ask-user card with multiple-choice questions: chips, a checkbox list
 *  for long options, and an answered card listing the ticked options. */
export const AskUserPlayground = () => (
  <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4">
    {CASES.map(({ id, part }) => (
      <section data-ask-user-case={id} key={id}>
        <AskUserCard
          isAwaitingUser
          onEditAndRerun={noop}
          onSubmit={noop}
          part={part}
        />
      </section>
    ))}
  </div>
);
