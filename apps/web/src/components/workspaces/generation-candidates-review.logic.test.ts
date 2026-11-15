import { describe, expect, test } from "bun:test";

import {
  acceptAllTargets,
  reviewableCandidates,
} from "@/components/workspaces/generation-candidates-review.logic";
import type { GenerationCandidate } from "@/components/workspaces/generation-candidates-review.logic";
import { toSafeId } from "@/lib/safe-id";

type CandidateRef = Pick<GenerationCandidate, "id" | "status">;

const id = (value: string) => toSafeId<"legalListGenerationCandidate">(value);

/** One candidate in every status a run's candidate can hold. */
const candidates = [
  { id: id("pending"), status: "pending" },
  { id: id("accepting"), status: "accepting" },
  { id: id("accepted"), status: "accepted" },
  { id: id("rejected"), status: "rejected" },
] satisfies CandidateRef[];

true satisfies Exclude<
  GenerationCandidate["status"],
  (typeof candidates)[number]["status"]
> extends never
  ? true
  : never;

describe("generation candidate review", () => {
  test("shows the candidates still waiting for a person, the in-flight one included", () => {
    expect(
      reviewableCandidates(candidates).map((candidate) => candidate.id),
    ).toEqual([id("pending"), id("accepting")]);
  });

  test("accept all sends only undecided candidates, never one already being accepted", () => {
    expect(acceptAllTargets(candidates)).toEqual(["pending"]);
  });

  test("accept all keeps proposal order", () => {
    expect(
      acceptAllTargets([
        { id: id("c"), status: "pending" },
        { id: id("a"), status: "rejected" },
        { id: id("b"), status: "pending" },
      ]),
    ).toEqual(["c", "b"]);
  });
});
