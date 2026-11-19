import { expect, test } from "bun:test";

import { suggestedSkillsFrom } from "./suggested-skills.logic";
import type { SuggestedSkill } from "./use-suggested-skills";

const retry = async () => await Promise.reject(new Error("not called"));
const loadedPage = { type: "items", items: {}, retry } as const;

const skill = {
  id: "skill-1",
  scope: "team",
  name: "Review the lease",
  command: "review-lease",
  body: "Check the break clause.",
  lastEdit: null,
} satisfies SuggestedSkill;

test("skills still being read are pending, not none", () => {
  expect(
    suggestedSkillsFrom({
      hasNextPage: false,
      skills: [],
      view: { type: "pending" },
    }),
  ).toEqual({ type: "pending" });
});

test("a page with nothing to offer stays pending while another page can", () => {
  expect(
    suggestedSkillsFrom({ hasNextPage: true, skills: [], view: loadedPage })
      .type,
  ).toBe("pending");
  expect(
    suggestedSkillsFrom({ hasNextPage: false, skills: [], view: loadedPage }),
  ).toEqual({ type: "loaded", feedback: loadedPage, skills: [] });
});

test("a failed page read settles the suggestions with its error", () => {
  const failedNextPage = {
    ...loadedPage,
    refetchError: new Error("page 2 failed"),
  } as const;
  expect(
    suggestedSkillsFrom({
      hasNextPage: true,
      skills: [],
      view: failedNextPage,
    }),
  ).toEqual({ type: "loaded", feedback: failedNextPage, skills: [] });
  const failedRead = {
    type: "error",
    error: new Error("down"),
    retry,
  } as const;
  expect(
    suggestedSkillsFrom({ hasNextPage: false, skills: [], view: failedRead }),
  ).toEqual({ type: "error", feedback: failedRead });
});

test("found suggestions show even while later pages load", () => {
  expect(
    suggestedSkillsFrom({
      hasNextPage: true,
      skills: [skill],
      view: loadedPage,
    }),
  ).toEqual({ type: "loaded", feedback: loadedPage, skills: [skill] });
});
