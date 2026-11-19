import type { SafeId } from "@/api/lib/branded-types";
import type { PinnedPlaybook } from "@/api/lib/document-review/run-contract";
import type {
  PlaybookPositions,
  PlaybookScope,
} from "@/api/lib/workflow/playbook-positions";

/** The live definition, as it stands right now. */
export type PlaybookDefinitionForPin = {
  id: SafeId<"playbookDefinition">;
  name: string;
  positions: PlaybookPositions;
  scope: PlaybookScope | null;
};

/** The newest `playbook_definition_versions` row for that definition whose
 *  `source` is an approval (see `loadLatestApprovedVersions`). */
export type PlaybookVersionForPin = {
  id: SafeId<"playbookDefinitionVersion">;
  name: string;
  positions: PlaybookPositions;
  scope: PlaybookScope | null;
};

type ResolvePlaybookPinArgs = {
  definition: PlaybookDefinitionForPin;
  latestApprovedVersion: PlaybookVersionForPin | null;
};

/**
 * Pin the playbook a run executes against.
 *
 * An approved snapshot wins over the live definition: approving is what makes
 * a playbook citable, and a definition edited after approval must not
 * retroactively change what an approved review measured. That covers the
 * scope as well as the positions: a scope edited after approval takes effect
 * only once the playbook is approved again, so a run pinned to the approval
 * keeps grading the documents the approved scope picks. A definition that has
 * never been approved is still runnable — an author reviewing their own draft
 * is the normal authoring loop — but the run records `provenance: "draft"` so
 * the result is never mistaken for an approved one.
 *
 * Either way the whole definition is embedded by value: the run outlives the
 * playbook and both of its tables.
 */
export const resolvePlaybookPin = ({
  definition,
  latestApprovedVersion,
}: ResolvePlaybookPinArgs): PinnedPlaybook => {
  if (latestApprovedVersion !== null) {
    return {
      definitionId: definition.id,
      versionId: latestApprovedVersion.id,
      provenance: "approved",
      definitionSnapshot: {
        name: latestApprovedVersion.name,
        positions: latestApprovedVersion.positions,
        scope: latestApprovedVersion.scope,
      },
    };
  }
  return {
    definitionId: definition.id,
    versionId: null,
    provenance: "draft",
    definitionSnapshot: {
      name: definition.name,
      positions: definition.positions,
      scope: definition.scope,
    },
  };
};
