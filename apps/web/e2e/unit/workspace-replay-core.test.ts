import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  BoundedEventTrail,
  MAX_EVENT_TRAIL_LENGTH,
  REPLAY_FIXTURE_NAME,
  parseReplayArtifact,
  serializeReplayArtifact,
  type ReplayArtifact,
} from "../soak/replay-artifact";
import {
  SeededRandom,
  hasWorkspaceAction,
  selectWeightedAction,
  type WeightedWorkspaceAction,
  type WorkspaceAction,
} from "../soak/workspace-actions";

const candidates = [
  { action: { type: "reload" }, weight: 1 },
  {
    action: {
      type: "select-control",
      control: { family: "workspace-view", key: "1" },
    },
    weight: 2,
  },
  {
    action: { type: "set-inspector-visibility", visible: false },
    weight: 1,
  },
] as const satisfies readonly WeightedWorkspaceAction[];

const generateActions = (seed: number, count: number): WorkspaceAction[] => {
  const random = new SeededRandom(seed);
  return Array.from({ length: count }, () =>
    selectWeightedAction(random, candidates),
  );
};

const artifact = (): ReplayArtifact => ({
  version: 1,
  seed: 42,
  stepLimit: 1,
  commit: "unknown",
  locale: "en-US",
  viewport: { width: 1440, height: 900 },
  fixture: {
    kind: "synthetic-workspace",
    name: REPLAY_FIXTURE_NAME,
  },
  events: [
    {
      step: 0,
      action: { type: "reload" },
      applicableActions: [{ type: "reload" }],
      before: {
        route: "/workspaces/:workspaceId/:viewId",
        selectedControls: [{ family: "workspace-view", key: "0" }],
      },
      after: {
        route: "/workspaces/:workspaceId/:viewId",
        selectedControls: [{ family: "workspace-view", key: "0" }],
      },
    },
  ],
});

describe("workspace replay randomness", () => {
  test("repeats the exact sequence for the same seed", () => {
    expect(generateActions(123, 50)).toEqual(generateActions(123, 50));
  });

  test("keeps different seeds independent without ambient randomness", () => {
    expect(generateActions(123, 20)).not.toEqual(generateActions(124, 20));
  });

  test("uses weights and rejects invalid candidate collections", () => {
    const random = new SeededRandom(1);
    expect(
      selectWeightedAction(random, [
        { action: { type: "reload" }, weight: 0 },
        {
          action: {
            type: "select-control",
            control: { family: "workspace-view", key: "0" },
          },
          weight: 1,
        },
      ]),
    ).toEqual({
      type: "select-control",
      control: { family: "workspace-view", key: "0" },
    });
    expect(() => selectWeightedAction(random, [])).toThrow(
      "Cannot choose an action from an empty collection",
    );
    expect(() =>
      selectWeightedAction(random, [
        { action: { type: "reload" }, weight: -1 },
      ]),
    ).toThrow("Action weights must be finite and non-negative");
  });

  test("matches the complete action payload rather than only its type", () => {
    expect(
      hasWorkspaceAction(candidates, {
        type: "set-inspector-visibility",
        visible: false,
      }),
    ).toBe(true);
    expect(
      hasWorkspaceAction(candidates, {
        type: "set-inspector-visibility",
        visible: true,
      }),
    ).toBe(false);
  });
});

describe("replay artifacts", () => {
  test("round-trips the versioned replay contract", () => {
    const expected = artifact();
    expect(
      parseReplayArtifact(JSON.parse(serializeReplayArtifact(expected))),
    ).toEqual(expected);
  });

  test("rejects unknown versions, actions, fields, and discontinuous events", () => {
    expect(() => parseReplayArtifact({ ...artifact(), version: 2 })).toThrow(
      v.ValiError,
    );
    expect(() =>
      parseReplayArtifact({
        ...artifact(),
        events: [
          {
            step: 0,
            action: { type: "not-a-real-action" },
            applicableActions: [],
            before: {
              route: "/workspaces/:workspaceId/:viewId",
              selectedControls: [],
            },
          },
        ],
      }),
    ).toThrow(v.ValiError);
    expect(() =>
      parseReplayArtifact({ ...artifact(), authorization: "secret" }),
    ).toThrow(v.ValiError);
    expect(() =>
      parseReplayArtifact({
        ...artifact(),
        events: [
          {
            ...artifact().events[0],
            action: {
              type: "select-control",
              control: { family: "../unsafe", key: "value" },
            },
          },
        ],
      }),
    ).toThrow(v.ValiError);
    expect(() =>
      parseReplayArtifact({
        ...artifact(),
        events: [{ ...artifact().events[0], step: 1 }],
      }),
    ).toThrow("Replay event steps must be contiguous and zero-based");
  });

  test("strips query and fragment data from state routes", () => {
    const input = artifact();
    const parsed = parseReplayArtifact({
      ...input,
      events: [
        {
          ...input.events[0],
          before: {
            route:
              "/workspaces/:workspaceId/:viewId?token=secret#document-text",
            selectedControls: [],
          },
        },
      ],
    });
    expect(parsed.events[0]?.before.route).toBe(
      "/workspaces/:workspaceId/:viewId",
    );
    expect(JSON.stringify(parsed)).not.toContain("secret");
    expect(JSON.stringify(parsed)).not.toContain("document-text");
  });

  test("rejects event collections larger than the configured run", () => {
    expect(() => parseReplayArtifact({ ...artifact(), stepLimit: 0 })).toThrow(
      "Replay artifact events exceed the step limit",
    );
  });

  test("rejects multiple selected values in one control family", () => {
    const input = artifact();
    expect(() =>
      parseReplayArtifact({
        ...input,
        events: [
          {
            ...input.events[0],
            before: {
              route: "/workspaces/:workspaceId/:viewId",
              selectedControls: [
                { family: "workspace-view", key: "0" },
                { family: "workspace-view", key: "1" },
              ],
            },
          },
        ],
      }),
    ).toThrow(
      "Replay state has multiple selected values in one control family",
    );
  });
});

describe("bounded failure trail", () => {
  test("retains exactly the newest events at the configured bound", () => {
    const trail = new BoundedEventTrail<number>();
    for (let index = 0; index < MAX_EVENT_TRAIL_LENGTH + 17; index += 1) {
      trail.add(index);
    }
    expect(trail.size).toBe(MAX_EVENT_TRAIL_LENGTH);
    expect(trail.toArray().at(0)).toBe(17);
    expect(trail.toArray().at(-1)).toBe(MAX_EVENT_TRAIL_LENGTH + 16);
  });

  test("does not expose mutable internal event storage", () => {
    const trail = new BoundedEventTrail<{ step: number }>(2);
    trail.add({ step: 1 });
    const copy = [...trail.toArray()];
    copy.push({ step: 2 });
    expect(trail.toArray()).toHaveLength(1);
  });
});
