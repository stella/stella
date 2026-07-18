/**
 * Symbols shared between `spawn-subagents-tool.ts` and `subagent-tools.ts`.
 *
 * The two modules need each other's names — `spawn-subagents-tool.ts` drains
 * the proposal buffer that `subagent-tools.ts`'s `projectToolMapForSubagent`
 * populates, while `projectToolMapForSubagent` drops `spawn_subagents` from
 * the projected set by name — which previously made them import each other
 * directly. Both import from here instead, so neither module depends on the
 * other.
 */

export const SPAWN_SUBAGENTS_TOOL_NAME = "spawn_subagents";

export type SubagentWriteProposal = {
  toolName: string;
  args: unknown;
};

export type SubagentProposalSink = {
  record: (proposal: SubagentWriteProposal) => void;
};

export type SubagentProposalBuffer = {
  sink: SubagentProposalSink;
  list: () => readonly SubagentWriteProposal[];
};

/**
 * A per-subagent-run buffer of writes the subagent proposed but did not
 * execute. Created fresh for each `runSubagent` call so a subagent's
 * result carries only its own proposed writes (see `spawn-subagents-tool.ts`).
 */
export const createSubagentProposalBuffer = (): SubagentProposalBuffer => {
  const proposals: SubagentWriteProposal[] = [];
  return {
    sink: {
      record: (proposal) => {
        proposals.push(proposal);
      },
    },
    list: () => proposals,
  };
};
