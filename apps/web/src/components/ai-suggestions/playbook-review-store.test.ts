import { beforeEach, describe, expect, test } from "bun:test";

import {
  reviewSessionKey,
  usePlaybookReviewStore,
} from "@/components/ai-suggestions/playbook-review-store";
import type { DocumentReviewSession } from "@/components/ai-suggestions/playbook-review-store";

const entityId = "entity-example";
const fileFieldId = "field-example";
const findingId = "finding-example";
const key = reviewSessionKey(entityId, fileFieldId);

const session = (): DocumentReviewSession => ({
  status: "idle",
  basis: null,
  results: { playbook: null, references: null },
  fixState: {},
  commentState: {},
  error: null,
  reviewedAt: 1,
  runId: null,
  topics: [],
  workspaceId: "workspace-example",
});

beforeEach(() => {
  usePlaybookReviewStore.setState({ sessions: { [key]: session() } });
});

describe("review comment transitions", () => {
  test("begin is a fixed point while a comment is applying or applied", () => {
    const store = usePlaybookReviewStore.getState();

    expect(store.beginComment(entityId, fileFieldId, findingId)).toBe(true);
    expect(store.beginComment(entityId, fileFieldId, findingId)).toBe(false);

    store.completeComment(entityId, fileFieldId, findingId);

    expect(store.beginComment(entityId, fileFieldId, findingId)).toBe(false);
    expect(
      usePlaybookReviewStore.getState().sessions[key]?.commentState[findingId],
    ).toEqual({ status: "applied" });
  });

  test("a cancelled attempt can be retried", () => {
    const store = usePlaybookReviewStore.getState();

    expect(store.beginComment(entityId, fileFieldId, findingId)).toBe(true);
    store.cancelComment(entityId, fileFieldId, findingId);

    expect(store.beginComment(entityId, fileFieldId, findingId)).toBe(true);
  });
});
