import type { AskEmailSource } from "@/lib/api-schemas";
import type { MailSnapshot } from "@/types";

export type AssistKind = "answer" | "draft" | "summary";

export type AssistTurnState =
  | { type: "loading" }
  | { sources: AskEmailSource[]; text: string; type: "ready" }
  | { message: string; type: "error" };

export type AssistTurn = {
  readonly id: string;
  /** The text sent to the model: the question, or the reply instruction. */
  readonly instruction: string;
  readonly kind: AssistKind;
  /** What the user asked for, shown as the turn's heading. */
  readonly prompt: string;
  readonly state: AssistTurnState;
};

/** The email and matter a request reads, taken when it is sent. */
type AssistContext = {
  snapshot: MailSnapshot;
  workspaceId: string | null;
};

export type AssistRequest = AssistContext &
  Pick<AssistTurn, "instruction" | "kind" | "prompt">;

type CreateAssistTurnsOptions = {
  errorFallback: string;
  maxTurns: number;
  newId: () => string;
  onChange: (turns: AssistTurn[]) => void;
  /** Answers one request; a rejection becomes `errorFallback`. */
  send: (request: AssistRequest) => Promise<AssistTurnState>;
};

const requestKey = ({
  instruction,
  kind,
  workspaceId,
}: AssistRequest): string => JSON.stringify([kind, workspaceId, instruction]);

/**
 * The assistant's turns for one email, newest first. A request identical to
 * one still running (a second click on Summarize) joins it instead of
 * starting another generation; a failed turn can be sent again in place.
 */
export const createAssistTurns = ({
  errorFallback,
  maxTurns,
  newId,
  onChange,
  send,
}: CreateAssistTurnsOptions) => {
  let turns: AssistTurn[] = [];
  const inFlight = new Set<string>();

  const commit = (next: AssistTurn[]) => {
    turns = next;
    onChange(turns);
  };

  const setState = (id: string, state: AssistTurnState) =>
    commit(turns.map((turn) => (turn.id === id ? { ...turn, state } : turn)));

  const start = (id: string, request: AssistRequest) => {
    const key = requestKey(request);
    inFlight.add(key);
    const settle = (state: AssistTurnState) => {
      inFlight.delete(key);
      setState(id, state);
    };
    send(request)
      .then(settle)
      .catch(() => settle({ message: errorFallback, type: "error" }));
  };

  return {
    ask: (request: AssistRequest) => {
      if (inFlight.has(requestKey(request))) {
        return;
      }
      const turn: AssistTurn = {
        id: newId(),
        instruction: request.instruction,
        kind: request.kind,
        prompt: request.prompt,
        state: { type: "loading" },
      };
      commit([turn, ...turns].slice(0, maxTurns));
      start(turn.id, request);
    },
    /** Sends a failed turn's request again, against the current email. */
    retry: (id: string, context: AssistContext) => {
      const turn = turns.find((candidate) => candidate.id === id);
      if (turn?.state.type !== "error") {
        return;
      }
      const request: AssistRequest = {
        instruction: turn.instruction,
        kind: turn.kind,
        prompt: turn.prompt,
        snapshot: context.snapshot,
        workspaceId: context.workspaceId,
      };
      if (inFlight.has(requestKey(request))) {
        return;
      }
      setState(id, { type: "loading" });
      start(id, request);
    },
  };
};
