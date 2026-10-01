import { panic } from "better-result";

import { isRecord } from "@/api/lib/type-guards";
import type { HarnessModel } from "@/api/tests/helpers/chat-approval-harness";
import { wirePromptBlocksOf } from "@/api/tests/helpers/chat-prompt-prefix";
import type {
  PromptPrefixLedger,
  WirePromptSections,
} from "@/api/tests/helpers/chat-prompt-prefix";
import type { ProviderWireProvider } from "@/api/tests/helpers/provider-wire-cassette";
import type {
  ProviderWireReplay,
  ReplayedRequest,
} from "@/api/tests/helpers/provider-wire-replay";

// The approval harness's model seam answered by the provider wire replay:
// the real adapter's SDK sends each request through `fetch`, and the replay's
// queue is the conversation's script.

const entriesOf = (value: unknown): readonly unknown[] => {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
};

/** Where each provider's request body holds its tools, system prompt and
 *  messages. */
export const WIRE_PROMPT_SECTIONS = {
  anthropic: (body) => ({
    messages: entriesOf(body["messages"]),
    system: entriesOf(body["system"]),
    tools: entriesOf(body["tools"]),
  }),
  bedrock: (body) => ({
    messages: entriesOf(body["messages"]),
    system: entriesOf(body["system"]),
    tools: entriesOf(
      isRecord(body["toolConfig"]) ? body["toolConfig"]["tools"] : undefined,
    ),
  }),
  google: (body) => ({
    messages: entriesOf(body["contents"]),
    system: entriesOf(body["systemInstruction"]),
    tools: entriesOf(body["tools"]),
  }),
  // The system prompt is the first message.
  mistral: (body) => ({
    messages: entriesOf(body["messages"]),
    system: [],
    tools: entriesOf(body["tools"]),
  }),
  openai: (body) => ({
    messages: entriesOf(body["input"]),
    system: entriesOf(body["instructions"]),
    tools: entriesOf(body["tools"]),
  }),
  openrouter: (body) => ({
    messages: entriesOf(body["messages"]),
    system: [],
    tools: entriesOf(body["tools"]),
  }),
} as const satisfies Record<
  ProviderWireProvider,
  (body: Record<string, unknown>) => WirePromptSections
>;

/** The harness's model seam, answered by the replay: its queue is the
 *  conversation's script. Every request the chat model answered is held to
 *  `chat.provider.prefix-stable` as its SDK wrote it. */
export const replayedHarnessModel = ({
  prompts,
  provider,
  replay,
}: {
  prompts: PromptPrefixLedger;
  provider: ProviderWireProvider;
  replay: ProviderWireReplay;
}): HarnessModel & {
  /** Every request the conversation sent so far, side calls and refused
   *  requests included, as the SDK wrote it. */
  sentRequests: () => readonly ReplayedRequest[];
} => {
  /** How many of the replay's requests `prompts` holds. */
  let recorded = 0;
  const sent: ReplayedRequest[] = [];
  const recordNewRequests = () => {
    const requests = replay.requests();
    sent.push(...requests.slice(recorded));
    for (const { body, exchange } of requests.slice(recorded)) {
      // Side calls go to another model; a refused request reached no one.
      if (typeof exchange !== "number") {
        continue;
      }
      const parsed: unknown = JSON.parse(body);
      if (!isRecord(parsed)) {
        panic("A chat request body is a JSON object");
      }
      prompts.record(
        wirePromptBlocksOf(WIRE_PROMPT_SECTIONS[provider](parsed)),
      );
    }
    recorded = requests.length;
  };
  return {
    modelOptionsOf: () => [],
    promptLedgerOf: () => {
      recordNewRequests();
      return prompts;
    },
    promptsOf: () => [],
    restore: () => undefined,
    script: (_threadId, ...runs) => {
      if (runs.length > 0) {
        panic("A replayed provider answers from its queue, not a script");
      }
    },
    stalled: async () => {
      await Promise.reject(
        new TypeError("A replayed provider does not stall on cue"),
      );
    },
    takeFindings: () => {
      recordNewRequests();
      // Taking the replay's findings clears its requests.
      const { unconsumed, unexpected } = replay.takeFindings();
      recorded = 0;
      // What the model is handed goes over the wire to a recorded answer, so
      // the scripted provider's record of it has no counterpart here.
      return {
        changedToolResults: [],
        unconsumedScripts: unconsumed,
        unscriptedCalls: unexpected,
      };
    },
    // The bodies the adapter sent, in its provider's wire format.
    takeRequests: () => replay.takeRequests(),
    sentRequests: () => {
      recordNewRequests();
      return sent;
    },
  };
};
