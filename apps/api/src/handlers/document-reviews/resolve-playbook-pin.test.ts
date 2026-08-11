import { describe, expect, test } from "bun:test";

import { resolvePlaybookPin } from "@/api/handlers/document-reviews/resolve-playbook-pin";
import type {
  PlaybookDefinitionForPin,
  PlaybookVersionForPin,
} from "@/api/handlers/document-reviews/resolve-playbook-pin";
import { toSafeId } from "@/api/lib/branded-types";
import type { PlaybookPositions } from "@/api/lib/workflow/playbook-positions";

const positionsWithIssue = (issue: string): PlaybookPositions => ({
  version: 2,
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
};

const approvedVersion: PlaybookVersionForPin = {
  id: toSafeId<"playbookDefinitionVersion">(Bun.randomUUIDv7()),
  name: "Approved name",
  positions: positionsWithIssue("As approved"),
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
    });
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
    });
  });
});
