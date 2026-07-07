import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";

import type { PlaybookScope } from "@/api/handlers/playbooks/positions";
import { playbookScopeSchema } from "@/api/handlers/playbooks/positions";
import {
  classifierParticipatedInPlan,
  filterPlaybooksByPresentLabels,
  playbookTrigger,
  selectRoutablePlaybooks,
} from "@/api/handlers/playbooks/route-playbooks";
import { toSafeId } from "@/api/lib/branded-types";

// ── The Elysia optional-UnionEnum coercion gotcha ──────────────────────
// Elysia coerces an absent optional UnionEnum to its FIRST member (driven by
// the TypeBox `default`). `manual` is first, so an absent trigger becomes the
// safe default rather than silently auto-running playbooks as `onClassified`.
describe("playbookScopeSchema — trigger", () => {
  test("accepts both trigger values and an absent trigger", () => {
    expect(Value.Check(playbookScopeSchema, {})).toBe(true);
    expect(Value.Check(playbookScopeSchema, { trigger: "manual" })).toBe(true);
    expect(Value.Check(playbookScopeSchema, { trigger: "onClassified" })).toBe(
      true,
    );
  });

  test("rejects an unknown trigger value", () => {
    expect(Value.Check(playbookScopeSchema, { trigger: "auto" })).toBe(false);
  });

  test("an absent trigger stays absent on the wire, never onClassified", () => {
    // Literal-union optionals (unlike UnionEnum) get no TypeBox default, so an
    // omitted trigger reaches the handler as undefined; `playbookTrigger` owns
    // the default to manual.
    expect(Value.Default(playbookScopeSchema, {})).toEqual({});
  });

  test("preserves an explicit onClassified trigger", () => {
    expect(
      Value.Default(playbookScopeSchema, { trigger: "onClassified" }),
    ).toEqual({ trigger: "onClassified" });
  });
});

describe("playbookTrigger", () => {
  test("defaults a null scope to manual", () => {
    expect(playbookTrigger(null)).toBe("manual");
  });

  test("defaults an absent trigger to manual", () => {
    expect(playbookTrigger({} as PlaybookScope)).toBe("manual");
  });

  test("returns the explicit trigger", () => {
    expect(playbookTrigger({ trigger: "manual" })).toBe("manual");
    expect(playbookTrigger({ trigger: "onClassified" })).toBe("onClassified");
  });
});

// ── Routing selection: only onClassified playbooks route ───────────────
const playbook = (id: string, scope: PlaybookScope | null) => ({ id, scope });

describe("selectRoutablePlaybooks", () => {
  test("keeps onClassified, drops manual and absent-trigger", () => {
    const onClassified = playbook("pb_auto", { trigger: "onClassified" });
    const manual = playbook("pb_manual", { trigger: "manual" });
    const untriggered = playbook("pb_absent", { documentTypeKey: "nda" });
    const nullScope = playbook("pb_null", null);

    const routable = selectRoutablePlaybooks([
      onClassified,
      manual,
      untriggered,
      nullScope,
    ]);

    expect(routable.map((p) => p.id)).toEqual(["pb_auto"]);
  });
});

// ── Applicability: workspace-wide vs doc-type present ──────────────────
describe("filterPlaybooksByPresentLabels", () => {
  const labelByKey = new Map([["nda", "NDA"]]);

  test("keeps a workspace-wide playbook regardless of present labels", () => {
    const wide = playbook("pb_wide", { trigger: "onClassified" });
    const result = filterPlaybooksByPresentLabels({
      playbooks: [wide],
      labelByKey,
      presentLabels: new Set(),
    });
    expect(result.map((p) => p.id)).toEqual(["pb_wide"]);
  });

  test("keeps a scoped playbook when its label is present", () => {
    const scoped = playbook("pb_nda", {
      trigger: "onClassified",
      documentTypeKey: "nda",
    });
    const result = filterPlaybooksByPresentLabels({
      playbooks: [scoped],
      labelByKey,
      presentLabels: new Set(["NDA"]),
    });
    expect(result.map((p) => p.id)).toEqual(["pb_nda"]);
  });

  test("drops a scoped playbook whose label is absent from the workspace", () => {
    const scoped = playbook("pb_nda", {
      trigger: "onClassified",
      documentTypeKey: "nda",
    });
    const result = filterPlaybooksByPresentLabels({
      playbooks: [scoped],
      labelByKey,
      presentLabels: new Set(["MSA"]),
    });
    expect(result).toHaveLength(0);
  });

  test("drops a scoped playbook whose key has no known label", () => {
    const scoped = playbook("pb_unknown", {
      trigger: "onClassified",
      documentTypeKey: "unknown",
    });
    const result = filterPlaybooksByPresentLabels({
      playbooks: [scoped],
      labelByKey,
      presentLabels: new Set(["NDA"]),
    });
    expect(result).toHaveLength(0);
  });

  test("is deterministic across repeated calls (idempotent re-trigger targets the same set)", () => {
    const playbooks = [
      playbook("pb_wide", { trigger: "onClassified" }),
      playbook("pb_nda", { trigger: "onClassified", documentTypeKey: "nda" }),
      playbook("pb_msa", { trigger: "onClassified", documentTypeKey: "msa" }),
    ];
    const args = {
      playbooks,
      labelByKey: new Map([
        ["nda", "NDA"],
        ["msa", "MSA"],
      ]),
      presentLabels: new Set(["NDA"]),
    };
    const first = filterPlaybooksByPresentLabels(args).map((p) => p.id);
    const second = filterPlaybooksByPresentLabels(args).map((p) => p.id);
    expect(first).toEqual(["pb_wide", "pb_nda"]);
    expect(second).toEqual(first);
  });
});

// ── Recursion guard ────────────────────────────────────────────────────
describe("classifierParticipatedInPlan", () => {
  const classifierPropertyId = toSafeId<"property">("prop_classifier");

  test("true when the classifier was in the completed plan", () => {
    expect(
      classifierParticipatedInPlan({
        classifierPropertyId,
        planPropertyIds: [
          toSafeId<"property">("prop_other"),
          classifierPropertyId,
        ],
      }),
    ).toBe(true);
  });

  test("false when the plan holds only materialized playbook columns (no re-trigger)", () => {
    expect(
      classifierParticipatedInPlan({
        classifierPropertyId,
        planPropertyIds: [
          toSafeId<"property">("prop_ask"),
          toSafeId<"property">("prop_verdict"),
        ],
      }),
    ).toBe(false);
  });

  test("false when the plan is empty", () => {
    expect(
      classifierParticipatedInPlan({
        classifierPropertyId,
        planPropertyIds: [],
      }),
    ).toBe(false);
  });
});
