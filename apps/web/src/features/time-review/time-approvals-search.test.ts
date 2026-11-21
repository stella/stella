import { expect, test } from "bun:test";
import * as v from "valibot";

import { timeApprovalsSearchSchema } from "./time-approvals-search";

test("the person filter keeps any user id, the matter filter only a UUID", () => {
  const matter = "0192f1a2-3b4c-7d5e-8f60-718293a4b5c6";
  // User ids come from the auth provider and are not UUIDs; a refused value
  // is dropped from the search, so a rejected person would silently unfilter.
  expect(
    v.parse(timeApprovalsSearchSchema, {
      date: "2026-10-27",
      member: "user_2pXq9LwZ",
      matter,
    }),
  ).toEqual({ date: "2026-10-27", member: "user_2pXq9LwZ", matter });
  expect(
    v.parse(timeApprovalsSearchSchema, {
      member: "",
      matter: "user_2pXq9LwZ",
    }),
  ).toEqual({});
});
