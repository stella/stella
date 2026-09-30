import { describe, expect, test } from "bun:test";

// The api's constants module has no imports of its own, so reading it here
// does not make the web app depend on the api.
import { MOCK_AI_STREAM_KIND_MARKERS } from "../../../api/src/dev/mock-ai-stream-kind-markers";
import { STREAM_CHUNK_COMMIT_BUDGET } from "../../src/features/chat/stream-chunk-commit-budget";

// The e2e render budget spec sends each budgeted kind's marker to the mock
// model; the mock streams the kind whose marker it reads. The two maps are
// spelled on both sides of the app boundary and must stay one map.

describe("the mock model's stream markers", () => {
  test("name exactly the kinds the thread page budgets, with the same text", () => {
    expect(
      Object.fromEntries(
        Object.entries(STREAM_CHUNK_COMMIT_BUDGET).map(
          ([kind, { mockAiMarker }]) => [kind, mockAiMarker],
        ),
      ),
    ).toEqual(MOCK_AI_STREAM_KIND_MARKERS);
  });
});
