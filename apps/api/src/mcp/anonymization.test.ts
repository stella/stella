import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const createPipelineContextMock = mock(() => ({
  pipeline: "context",
}));
const redactTextMock = mock((redactedText: string) => ({
  entityCount: 0,
  redactedText,
}));
const runPipelineMock = mock(async () => []);
const originalRandomUUID = crypto.randomUUID;

void mock.module("@stll/anonymize-wasm", () => ({
  createPipelineContext: createPipelineContextMock,
  DEFAULT_ENTITY_LABELS: ["PERSON"],
  DEFAULT_OPERATOR_CONFIG: { replaceWith: "entity_label" },
  redactText: redactTextMock,
  runPipeline: runPipelineMock,
}));

const { anonymizeTextFields } = await import("@/api/mcp/anonymization");

describe("anonymizeTextFields", () => {
  beforeEach(() => {
    createPipelineContextMock.mockReset();
    redactTextMock.mockReset();
    runPipelineMock.mockReset();
    createPipelineContextMock.mockReturnValue({
      pipeline: "context",
    });
    redactTextMock.mockImplementation((redactedText: string) => ({
      entityCount: 0,
      redactedText,
    }));
    runPipelineMock.mockResolvedValue([]);
    crypto.randomUUID = originalRandomUUID;
  });

  afterEach(() => {
    crypto.randomUUID = originalRandomUUID;
  });

  test("regenerates markers when crafted content contains a candidate delimiter", async () => {
    let randomUUIDCallCount = 0;
    const uuidSequence: ReturnType<typeof crypto.randomUUID>[] = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ];
    const collidingMarker =
      "[[[__stella_mcp_anonymized_field_00000000-0000-4000-8000-000000000001_1__]]]";
    crypto.randomUUID = () => {
      randomUUIDCallCount += 1;
      const next = uuidSequence.shift();
      if (next === undefined) {
        throw new Error("Expected another UUID");
      }

      return next;
    };

    const result = await anonymizeTextFields({
      fields: ["Title", `Body ${collidingMarker} tail`],
      workspaceId: "ws_1",
    });

    expect(randomUUIDCallCount).toBe(2);
    expect(runPipelineMock).toHaveBeenCalledWith(
      expect.objectContaining({
        fullText:
          "[[[__stella_mcp_anonymized_field_00000000-0000-4000-8000-000000000002_0__]]]Title[[[__stella_mcp_anonymized_field_00000000-0000-4000-8000-000000000002_1__]]]Body [[[__stella_mcp_anonymized_field_00000000-0000-4000-8000-000000000001_1__]]] tail",
      }),
    );
    expect(result).toEqual({
      entityCount: 0,
      fields: ["Title", `Body ${collidingMarker} tail`],
    });
  });
});
