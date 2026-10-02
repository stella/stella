import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { STREAM_CHUNK_COMMIT_BUDGET } from "../../src/features/chat/stream-chunk-commit-budget";

// The e2e render budget spec sends each budgeted kind's marker to the mock
// model; the mock streams the kind whose marker it reads. The two maps are
// spelled on both sides of the app boundary and must stay one map. The web
// app does not import the api, so the api's map is read as the source it is.

const MARKERS_SOURCE = path.resolve(
  import.meta.dir,
  "../../../api/src/dev/mock-ai-stream-kind-markers.ts",
);

/** The `kind: "marker"` entries of `MOCK_AI_STREAM_KIND_MARKERS`. */
const apiMarkers = (): Record<string, string> => {
  const source = readFileSync(MARKERS_SOURCE, "utf-8");
  const body =
    /MOCK_AI_STREAM_KIND_MARKERS = \{(?<body>[^}]*)\}/u.exec(source)?.groups?.[
      "body"
    ] ?? "";
  return Object.fromEntries(
    [
      ...body.matchAll(
        /^\s*(?:"(?<quoted>[^"]+)"|(?<bare>[\w-]+)):\s*"(?<marker>[^"]*)",?$/gmu,
      ),
    ].map(({ groups }) => [
      groups?.["quoted"] ?? groups?.["bare"] ?? "",
      groups?.["marker"] ?? "",
    ]),
  );
};

describe("the mock model's stream markers", () => {
  test("name exactly the kinds the thread page budgets, with the same text", () => {
    const markers = apiMarkers();
    // The source parses: a map this test cannot read is not agreement.
    expect(Object.keys(markers).length).toBeGreaterThan(0);
    const budgeted: Record<string, string> = Object.fromEntries(
      Object.entries(STREAM_CHUNK_COMMIT_BUDGET).map(
        ([kind, { mockAiMarker }]) => [kind, mockAiMarker],
      ),
    );
    expect(budgeted).toEqual(markers);
  });
});
