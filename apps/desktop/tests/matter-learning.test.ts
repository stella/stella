import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import type {
  DesktopMatterResolution,
  DesktopTimeEntryMatterCandidate,
} from "@stll/api-contract/desktop-time-entries";
import { assertProperty } from "@stll/property-testing";

import { timedSegments } from "../src/activity/activity-logic";
import { matchDay } from "../src/activity/day-review-logic";
import {
  acceptProposal,
  CORRECTION_FACTOR,
  decayedWeight,
  declineProposal,
  EMPTY_MATTER_LEARNING,
  evidenceTokens,
  learn,
  LEARNED_HALF_LIFE_MS,
  matchingRule,
  type MatterLearning,
  ruleProposals,
  type SegmentEvidence,
  suggestedMatterIds,
} from "../src/activity/matter-learning";

const NOW_MS = Date.UTC(2026, 10, 25, 12);
const DAY_MS = 24 * 60 * 60 * 1000;

const matter = (
  id: string,
  name: string,
  signals: Partial<DesktopTimeEntryMatterCandidate["signals"]> = {},
) =>
  ({
    id,
    name,
    reference: null,
    color: null,
    clientName: null,
    signals: {
      lastWorkedAt: null,
      newlyAssignedAt: null,
      upcomingDeadline: null,
      ...signals,
    },
  }) satisfies DesktopTimeEntryMatterCandidate;

const document = (documentPath: string): SegmentEvidence => ({
  app: "Word",
  title: null,
  documentPath,
});
const windowTitle = (title: string): SegmentEvidence => ({
  app: "Outlook",
  title,
  documentPath: null,
});

const at = (seconds: number) =>
  new Date(Date.UTC(2026, 10, 25, 9, 0, seconds)).toISOString();
const segment = ({
  start,
  title = null,
  document: path = null,
  matterId = null,
}: {
  start: number;
  title?: string | null;
  document?: string | null;
  matterId?: string | null;
}) => ({
  appIdentifier: "word",
  appName: "Word",
  start: at(start),
  end: at(start + 30),
  windowTitle: title,
  document: path,
  matterId,
});

describe("learned weights", () => {
  test("decay never raises a weight and halves it every half-life", () => {
    assertProperty(
      "matter learning decay is monotone and halves per half-life",
      fc.property(
        fc.double({ min: 0, max: 1e6, noNaN: true }),
        fc.integer({ min: 0, max: 10 * 365 }),
        fc.integer({ min: 0, max: 365 }),
        fc.integer({ min: 0, max: 365 }),
        (weight, startDay, firstDays, moreDays) => {
          const atMs = startDay * DAY_MS;
          const earlier = decayedWeight(
            { weight, atMs },
            atMs + firstDays * DAY_MS,
          );
          const later = decayedWeight(
            { weight, atMs },
            atMs + (firstDays + moreDays) * DAY_MS,
          );
          expect(later).toBeLessThanOrEqual(earlier);
          expect(earlier).toBeLessThanOrEqual(weight);
          expect(
            decayedWeight({ weight, atMs }, atMs + LEARNED_HALF_LIFE_MS),
          ).toBeCloseTo(weight / 2, 6);
        },
      ),
    );
  });

  test("a correction never raises the wrong pair and always credits the right one", () => {
    const matterIds = ["a", "b", "c"];
    const token = fc.constantFrom("novak", "lease", "riverside", "draft");
    assertProperty(
      "matter learning correction never increases the wrong pair",
      fc.property(
        fc.array(
          fc.record({
            token,
            matterId: fc.constantFrom(...matterIds),
            weight: fc.double({ min: 0, max: 50, noNaN: true }),
            atMs: fc.integer({ min: NOW_MS - 400 * DAY_MS, max: NOW_MS }),
          }),
          { maxLength: 12 },
        ),
        fc.array(token, { minLength: 1, maxLength: 3 }),
        fc.constantFrom(...matterIds),
        fc.constantFrom(...matterIds),
        (learned, titleTokens, confirmed, suggested) => {
          const before: MatterLearning = {
            rules: [],
            learned,
            tallies: [],
          };
          const evidence = [windowTitle(titleTokens.join(" "))];
          const after = learn(before, {
            evidence,
            matterId: confirmed,
            suggestedMatterId: suggested,
            nowMs: NOW_MS,
          });
          const weightOf = (
            learning: MatterLearning,
            tokenName: string,
            matterId: string,
          ) =>
            learning.learned
              .filter(
                (row) => row.token === tokenName && row.matterId === matterId,
              )
              .reduce((sum, row) => sum + decayedWeight(row, NOW_MS), 0);
          for (const tokenName of evidenceTokens(evidence)) {
            const rightBefore = weightOf(before, tokenName, confirmed);
            expect(weightOf(after, tokenName, confirmed)).toBeGreaterThan(
              rightBefore,
            );
            if (suggested !== confirmed) {
              const wrongBefore = weightOf(before, tokenName, suggested);
              expect(weightOf(after, tokenName, suggested)).toBeLessThanOrEqual(
                wrongBefore * CORRECTION_FACTOR + 1e-9,
              );
            }
          }
        },
      ),
    );
  });

  test("learned weights suggest a matter with the token as its reason", () => {
    const lease = matter("lease", "Lease renewal");
    const services = matter("services", "Services agreement");
    let learning = EMPTY_MATTER_LEARNING;
    for (const offset of [3, 2]) {
      learning = learn(learning, {
        evidence: [windowTitle("Novák comments on schedule")],
        matterId: "lease",
        suggestedMatterId: null,
        nowMs: NOW_MS - offset * DAY_MS,
      });
    }
    const day = matchDay({
      segments: timedSegments([segment({ start: 0, title: "Novák schedule" })]),
      candidates: [lease, services],
      resolved: [],
      captureDetails: true,
      manualAssignments: [],
      draftedEntries: [],
      learning,
      nowMs: NOW_MS,
    });
    expect(day.segments.at(0)?.matter?.id).toBe("lease");
    expect(day.segments.at(0)?.confidence).toBe("likely");
    expect(day.segments.at(0)?.reason.type).toBe("learned");
    // Without consent to details, nothing is read and nothing is suggested.
    const withoutDetails = matchDay({
      segments: timedSegments([segment({ start: 0, title: "Novák schedule" })]),
      candidates: [lease, services],
      resolved: [],
      captureDetails: false,
      manualAssignments: [],
      draftedEntries: [],
      learning,
      nowMs: NOW_MS,
    });
    expect(withoutDetails.segments.at(0)?.matter).toBeNull();
  });
});

describe("member rules", () => {
  test("a folder rule matches the full path on either platform's separators", () => {
    const rule = {
      id: "rule",
      field: "documentPath",
      op: "startsWith",
      value: "C:\\Matters\\2024-017\\",
      matterId: "lease",
    } as const;
    const isOpen = () => true;
    expect(
      matchingRule(
        [rule],
        document("c:/matters/2024-017/Draft v3.docx"),
        isOpen,
      ),
    ).toBe(rule);
    expect(
      matchingRule([rule], document("C:/Matters/2024-018/Draft.docx"), isOpen),
    ).toBeNull();
    expect(
      matchingRule([rule], document("C:/Matters/2024-017/x.docx"), () => false),
    ).toBeNull();
  });

  test("the second confirmation of the same evidence proposes a rule; declining it stops the proposal", () => {
    const confirm = (learning: MatterLearning) =>
      learn(learning, {
        evidence: [document("/Volumes/Matters/2024-017 Novák/Draft v3.docx")],
        matterId: "lease",
        suggestedMatterId: null,
        nowMs: NOW_MS,
      });
    const once = confirm(EMPTY_MATTER_LEARNING);
    expect(ruleProposals(once)).toEqual([]);
    const twice = confirm(once);
    const [proposal] = ruleProposals(twice);
    expect(proposal).toMatchObject({
      field: "documentPath",
      op: "startsWith",
      value: "/Volumes/Matters/2024-017 Novák/",
      matterId: "lease",
    });
    if (proposal === undefined) {
      return;
    }
    expect(ruleProposals(declineProposal(twice, proposal))).toEqual([]);
    expect(ruleProposals(confirm(declineProposal(twice, proposal)))).toEqual(
      [],
    );
    const accepted = acceptProposal(twice, proposal, "rule-1");
    expect(accepted.rules).toEqual([
      {
        id: "rule-1",
        field: "documentPath",
        op: "startsWith",
        value: "/Volumes/Matters/2024-017 Novák/",
        matterId: "lease",
      },
    ]);
    expect(ruleProposals(confirm(accepted))).toEqual([]);
  });

  test("order: a session outranks a rule, a rule outranks names, and signals only break ties", () => {
    const lease = matter("lease", "Riverside lease", {
      lastWorkedAt: "2026-11-20",
    });
    const services = matter("services", "Riverside services");
    const learning: MatterLearning = {
      rules: [
        {
          id: "rule",
          field: "title",
          op: "contains",
          value: "board pack",
          matterId: "services",
        },
      ],
      learned: [],
      tallies: [],
    };
    const day = matchDay({
      segments: timedSegments([
        segment({ start: 0, title: "Board pack", matterId: "lease" }),
        segment({ start: 30, title: "Board pack" }),
        segment({ start: 60, title: "Lease and services notes" }),
      ]),
      candidates: [lease, services],
      resolved: [],
      captureDetails: true,
      manualAssignments: [],
      draftedEntries: [],
      learning,
      nowMs: NOW_MS,
    });
    expect(
      day.segments.map(({ matter: matched, confidence, reason }) => [
        matched?.id,
        confidence,
        reason.type,
      ]),
    ).toEqual([
      ["lease", "strong", "session"],
      ["services", "rule", "rule"],
      // Each matter has a name hit; recent work breaks the tie.
      ["lease", "likely", "name"],
    ]);
    const unsignalled = matchDay({
      segments: timedSegments([
        segment({ start: 0, title: "Lease and services notes" }),
      ]),
      candidates: [matter("lease", "Riverside lease"), services],
      resolved: [],
      captureDetails: true,
      manualAssignments: [],
      draftedEntries: [],
      learning: EMPTY_MATTER_LEARNING,
      nowMs: NOW_MS,
    });
    expect(unsignalled.segments.at(0)?.matter).toBeNull();
  });

  test("rules and learning only ever resolve to matters the same read can open", () => {
    const ids = ["a", "b", "c", "d"];
    const pooledId = fc.constantFrom(...ids);
    const word = fc.constantFrom("alpha", "bravo", "charlie", "delta", "echo");
    const text = fc
      .array(word, { minLength: 1, maxLength: 3 })
      .map((words) => words.join(" "));
    assertProperty(
      "matter rules and learning name only matters the read can open",
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            field: fc.constantFrom("title", "documentPath", "app"),
            op: fc.constantFrom("contains", "startsWith"),
            value: word,
            matterId: pooledId,
          }),
          { maxLength: 5 },
        ),
        fc.array(
          fc.record({
            token: word,
            matterId: pooledId,
            weight: fc.double({ min: 0, max: 20, noNaN: true }),
            atMs: fc.integer({ min: NOW_MS - 90 * DAY_MS, max: NOW_MS }),
          }),
          { maxLength: 20 },
        ),
        fc.array(fc.constantFrom("shortlisted", "resolved", "inaccessible"), {
          minLength: ids.length,
          maxLength: ids.length,
        }),
        fc.array(fc.record({ title: text, folder: word }), { maxLength: 6 }),
        (rules, learned, standings, recorded) => {
          const pool = ids.map((id) => matter(id, `Matter ${id}`));
          const shortlist = pool.filter(
            (_, index) => standings[index] === "shortlisted",
          );
          const resolved = pool.flatMap(
            (candidate, index): DesktopMatterResolution[] => {
              switch (standings[index]) {
                case "resolved":
                  return [{ type: "accessible", matter: candidate }];
                case "inaccessible":
                  return [{ type: "inaccessible", id: candidate.id }];
                default:
                  return [];
              }
            },
          );
          const open = new Set([
            ...shortlist.map(({ id }) => id),
            ...resolved.flatMap((resolution) =>
              resolution.type === "accessible" ? [resolution.matter.id] : [],
            ),
          ]);
          const learning = { rules, learned, tallies: [] };
          const segments = recorded.map(({ title, folder }, index) =>
            segment({
              start: index * 30,
              title,
              document: `/${folder}/${title}.docx`,
            }),
          );
          const day = matchDay({
            segments: timedSegments(segments),
            candidates: shortlist,
            resolved,
            captureDetails: true,
            manualAssignments: [],
            draftedEntries: [],
            learning,
            nowMs: NOW_MS,
          });
          for (const { matter: matched } of [...day.segments, ...day.groups]) {
            if (matched !== null) {
              expect(open.has(matched.id)).toBe(true);
            }
          }
          // Every matter a rule or weight could name is asked for first.
          const asked = new Set(
            suggestedMatterIds({
              evidence: timedSegments(segments).map((timed) => ({
                app: timed.appName,
                title: timed.windowTitle,
                documentPath: timed.document,
              })),
              learning,
              nowMs: NOW_MS,
            }),
          );
          for (const { matter: matched, reason } of day.segments) {
            if (reason.type === "rule" || reason.type === "learned") {
              expect(asked.has(matched?.id ?? "")).toBe(true);
            }
          }
        },
      ),
    );
  });
});
