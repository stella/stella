/**
 * The proposal call's model failure. The endpoint's own preparation and model
 * steps are injected, so what runs here is the branch that turns the step's
 * `WorkflowIntegrationError` into an answer: a provider that refused for a
 * reason the caller can act on must not arrive as an opaque 500.
 */

import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { prepareReferenceProposal } from "@/api/handlers/document-reviews/prepare-proposal";
import type { proposeReferencePositions } from "@/api/handlers/document-reviews/reference-positions";
import { toSafeId } from "@/api/lib/branded-types";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import {
  modelStepFailure,
  PROVIDER_FAILURE_CASES,
} from "@/api/tests/helpers/provider-failure-cases";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import type proposePositions from "./propose-positions";
import { createProposePositions } from "./propose-positions";

type ProposePositionsCtx = Parameters<typeof proposePositions.handler>[0];

const WORKSPACE_ID = toSafeId<"workspace">(
  "00000000-0000-0000-0000-000000000001",
);
const ENTITY_ID = toSafeId<"entity">("00000000-0000-0000-0000-000000000002");
const ENTITY_VERSION_ID = toSafeId<"entityVersion">(
  "00000000-0000-0000-0000-000000000003",
);
const FIELD_ID = toSafeId<"field">("00000000-0000-0000-0000-000000000004");
const REFERENCE_ENTITY_ID = toSafeId<"entity">(
  "00000000-0000-0000-0000-000000000006",
);

const body = {
  target: { entityId: ENTITY_ID, fileFieldId: FIELD_ID },
  references: [{ entityId: REFERENCE_ENTITY_ID, fileFieldId: FIELD_ID }],
  seededPositions: [],
  perspective: { role: "Purchaser", name: "Example Holdings a.s." },
};

/**
 * Preparation succeeds: the failure under test is the model step's, and a
 * request that never reached a provider would not exercise the branch.
 */
const prepareProposalFake = asTestRaw<typeof prepareReferenceProposal>(
  async function* () {
    return Result.ok({
      target: { kind: "docx" },
      references: [],
      targetEntityVersionId: ENTITY_VERSION_ID,
    });
  },
);

const proposalFailingWith = (
  cause: unknown,
): typeof proposeReferencePositions =>
  asTestRaw<typeof proposeReferencePositions>(
    async () => await Promise.resolve(Result.err(modelStepFailure(cause))),
  );

describe("proposePositions", () => {
  for (const { cause, message, name, status } of PROVIDER_FAILURE_CASES) {
    test(`answers ${name} with the status that names it`, async () => {
      const handler = createProposePositions({
        prepareProposal: prepareProposalFake,
        proposePositions: proposalFailingWith(cause),
      });

      const result = await handler.handler(
        createTestHandlerContext<ProposePositionsCtx>({
          body,
          workspaceId: WORKSPACE_ID,
        }),
      );

      if (!("code" in result)) {
        throw new Error("Expected the provider failure to return a status");
      }
      expect(result.code).toBe(status);
      expect(result.response).toMatchObject({ message });
    });
  }
});
