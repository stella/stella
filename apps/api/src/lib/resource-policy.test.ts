import { describe, expect, test } from "bun:test";

import { resourceRef, RESOURCE_TYPE, toSafeId } from "@stll/api-contract";

import { getResourceAuthorizationDisposition } from "@/api/lib/resource-authorization";
import { getResourceBacklinkDisposition } from "@/api/lib/resource-backlinks";
import {
  MCP_RESOURCE_SERIALIZATION_DISPOSITION,
  serializeAuthorizedCorpusMcpResourceName,
} from "@/api/mcp/resource-serialization";

describe("resource consumer policies", () => {
  test("keeps identity separate from domain-owned authorization", () => {
    const entity = resourceRef({
      type: RESOURCE_TYPE.ENTITY,
      id: toSafeId<"entity">("entity-1"),
    });

    expect(getResourceAuthorizationDisposition(entity)).toEqual({
      type: "domain_policy",
      owner: "entities",
    });
    expect(getResourceBacklinkDisposition(entity)).toEqual({
      type: "supported",
      owners: ["entity_links"],
    });
    expect(MCP_RESOURCE_SERIALIZATION_DISPOSITION[entity.type]).toEqual({
      type: "chat_ref_mediated",
    });
  });

  test("serializes a corpus resource only through its explicit policy", () => {
    const decision = resourceRef({
      type: RESOURCE_TYPE.CASE_LAW_DECISION,
      id: toSafeId<"caseLawDecision">("decision-1"),
    });

    expect(getResourceAuthorizationDisposition(decision)).toEqual({
      type: "corpus_policy",
      owner: "case_law",
    });
    expect(MCP_RESOURCE_SERIALIZATION_DISPOSITION[decision.type]).toEqual({
      type: "authorized_corpus_resource_name",
    });
    expect(String(serializeAuthorizedCorpusMcpResourceName(decision))).toBe(
      "stella://resource/case_law_decision/id=decision-1",
    );
  });
});
