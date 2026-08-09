import { describe, expect, test } from "bun:test";

import { topicsFromPlaybookFindings } from "@/components/ai-suggestions/playbook-review-topics.logic";

describe("pure playbook result topics", () => {
  test("derive exactly the executable findings instead of mirroring definition positions", () => {
    const findings = [
      { positionId: "reviewed-position", issue: "Reviewed issue" },
    ];
    const topics = topicsFromPlaybookFindings(findings, [
      {
        type: "playbook",
        topicId: "reviewed-position",
        positionId: "reviewed-position",
        title: "Stale reviewed title",
        context: "Reviewer guidance",
        included: true,
      },
      {
        type: "playbook",
        topicId: "non-executable-position",
        positionId: "non-executable-position",
        title: "File-backed position",
        context: "",
        included: true,
      },
    ]);

    expect(topics).toEqual([
      {
        type: "playbook",
        topicId: "reviewed-position",
        positionId: "reviewed-position",
        title: "Reviewed issue",
        context: "Reviewer guidance",
        included: true,
      },
    ]);
  });
});
