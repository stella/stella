import { describe, expect, test } from "bun:test";

import {
  composeGithubIssueBody,
  neutralizeGithubReferences,
} from "@/api/handlers/feedback/report-body";

const TRACKER_MENTION = /@[A-Za-z0-9]/u;
const TRACKER_ISSUE_REFERENCE = /#[0-9]/u;

describe("issue body", () => {
  test("no reporter text can resolve to a mention or an issue reference", () => {
    const body = composeGithubIssueBody({
      receipt: "FB-7K2M-9QXA",
      serverVersion: "1.2.3",
      report: {
        kind: "bug",
        area: "templates",
        title: "unused here",
        whatHappened: "cc @octocat and @org/team, see #42",
        steps: "1. ping @someone\n2. link #7",
        context: { route: "/x/@y/#1" },
      },
    });
    expect(body).not.toMatch(TRACKER_MENTION);
    expect(body).not.toMatch(TRACKER_ISSUE_REFERENCE);
    expect(body).toContain("FB-7K2M-9QXA");
  });

  test("neutralizing is idempotent and leaves plain text alone", () => {
    const once = neutralizeGithubReferences("mail @ home, C# code, @user #12");
    expect(neutralizeGithubReferences(once)).toBe(once);
    expect(neutralizeGithubReferences("no sigils here")).toBe("no sigils here");
  });
});
