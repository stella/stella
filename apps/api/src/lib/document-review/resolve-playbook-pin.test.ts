import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { resolvePlaybookPin } from "@/api/lib/document-review/resolve-playbook-pin";
import type {
  PlaybookDefinitionForPin,
  PlaybookVersionForPin,
} from "@/api/lib/document-review/resolve-playbook-pin";
import type { PlaybookPositions } from "@/api/lib/workflow/playbook-positions";

const positionsWithIssue = (issue: string): PlaybookPositions => ({
  version: 3,
  items: [
    {
      mode: "extract",
      sourceId: "11111111-1111-4111-8111-111111111111",
      issue,
      ask: {
        question: "What is the notice period?",
        content: { version: 1, type: "text" },
      },
      enabled: true,
    },
  ],
});

const definition: PlaybookDefinitionForPin = {
  id: toSafeId<"playbookDefinition">(Bun.randomUUIDv7()),
  name: "Live draft name",
  positions: positionsWithIssue("Edited after approval"),
  // The scope as edited after approval: the live definition now targets
  // leases, while the approval below still covers NDAs.
  scope: { documentTypeKey: "lease" },
};

const approvedVersion: PlaybookVersionForPin = {
  id: toSafeId<"playbookDefinitionVersion">(Bun.randomUUIDv7()),
  name: "Approved name",
  positions: positionsWithIssue("As approved"),
  scope: { documentTypeKey: "nda" },
};

describe("resolvePlaybookPin", () => {
  test("pins the approved snapshot, not the edited live definition", () => {
    const pin = resolvePlaybookPin({
      definition,
      latestApprovedVersion: approvedVersion,
    });

    expect(pin).toMatchObject({
      definitionId: definition.id,
      versionId: approvedVersion.id,
      provenance: "approved",
    });
    expect(pin.definitionSnapshot).toEqual({
      name: approvedVersion.name,
      positions: approvedVersion.positions,
      scope: approvedVersion.scope,
    });
  });

  test("pins the approved scope, not the scope edited after approval", () => {
    // The issue's reproduction: approved scoped to NDA, then edited to
    // Lease without re-approval. A run pinned to the approval must keep
    // grading NDAs, never the leases the unapproved edit targets.
    const pin = resolvePlaybookPin({
      definition,
      latestApprovedVersion: approvedVersion,
    });

    expect(pin.definitionSnapshot.scope).toEqual({
      documentTypeKey: "nda",
    });
    expect(pin.definitionSnapshot.scope).not.toEqual(definition.scope);
  });

  test("records draft provenance when the playbook was never approved", () => {
    const pin = resolvePlaybookPin({
      definition,
      latestApprovedVersion: null,
    });

    expect(pin).toMatchObject({
      definitionId: definition.id,
      versionId: null,
      provenance: "draft",
    });
    expect(pin.definitionSnapshot).toEqual({
      name: definition.name,
      positions: definition.positions,
      scope: definition.scope,
    });
  });

  test("a never-approved playbook keeps its live scope", () => {
    const pin = resolvePlaybookPin({
      definition,
      latestApprovedVersion: null,
    });

    expect(pin.definitionSnapshot.scope).toEqual({
      documentTypeKey: "lease",
    });
  });
});
