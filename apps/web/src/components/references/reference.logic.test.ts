import { describe, expect, test } from "bun:test";

import {
  entityDisplayLabel,
  entityReferenceHref,
  mentionAttrsToHref,
  mentionTagAttrs,
  referenceFromDecisionRoute,
  referenceFromHref,
  referenceFromMentionAttrs,
  resolveReferenceVisual,
  UNRESOLVED_REFERENCE_HREF,
} from "@/components/references/reference.logic";
import type {
  ChatReference,
  ReferenceLiveFacts,
} from "@/components/references/reference.logic";

const MATTER_ID = "0dc54d0c-10d7-501d-897e-e801dbd0998c";
const OTHER_MATTER_ID = "4e919658-a448-5354-8e3a-e99911214d2c";
const TASK_ID = "c09ec856-d945-5ecc-82e3-bb5382165f34";
const USER_ID = "user-7";

const PENDING_FACTS: ReferenceLiveFacts = {
  entity: { status: "pending" },
  hint: null,
  matter: { status: "pending" },
  user: { status: "pending" },
};

const facts = (overrides: Partial<ReferenceLiveFacts>): ReferenceLiveFacts => ({
  ...PENDING_FACTS,
  ...overrides,
});

const referenceOf = (
  parsed: ReturnType<typeof referenceFromHref>,
): ChatReference => {
  if (parsed?.type !== "reference") {
    throw new Error(`Expected a reference, got ${JSON.stringify(parsed)}`);
  }
  return parsed.reference;
};

/** The composer's attrs for a task picked in another matter's drill-down. */
const COMPOSER_ATTRS = {
  id: TASK_ID,
  label: "Call the counterparty",
  category: "entity",
  kind: "task",
  mimeType: null,
  matterId: MATTER_ID,
  sourceWorkspaceId: MATTER_ID,
};

/** The same task, as every source spells it. */
const TASK_SOURCES = {
  composer: () => referenceFromMentionAttrs(COMPOSER_ATTRS),
  optimisticMessage: () =>
    referenceFromMentionAttrs(
      mentionTagAttrs(
        (name) =>
          ({
            "data-id": TASK_ID,
            "data-label": "Call the counterparty",
            "data-category": "entity",
            "data-kind": "task",
            "data-matter-id": MATTER_ID,
            "data-source-workspace-id": MATTER_ID,
          })[name] ?? null,
      ),
    ),
  persistedMessage: () =>
    referenceOf(
      referenceFromHref(
        `#stella-entity=${MATTER_ID}:${TASK_ID}`,
        "Call the counterparty",
      ),
    ),
  sameMatterPersistedMessage: () =>
    referenceOf(
      referenceFromHref(`#stella-entity=${TASK_ID}`, "Call the counterparty", {
        renderWorkspaceId: MATTER_ID,
      }),
    ),
  assistantAnswer: () =>
    referenceOf(
      referenceFromHref(
        `#stella-entity=${MATTER_ID}:${TASK_ID}`,
        "Call the counterparty",
        { renderWorkspaceId: OTHER_MATTER_ID },
      ),
    ),
  legacyAssistantAnswer: () =>
    referenceOf(
      referenceFromHref(
        `#stella-entity-ref=${MATTER_ID}:${TASK_ID}`,
        "Call the counterparty",
      ),
    ),
} as const;

describe("one reference, every source", () => {
  test.each(Object.entries(TASK_SOURCES))(
    "%s names the same task in the same matter",
    (_source, read) => {
      expect(read()).toMatchObject({
        type: "entity",
        entityId: TASK_ID,
        matterId: MATTER_ID,
        label: "Call the counterparty",
      });
    },
  );

  test.each(Object.entries(TASK_SOURCES))(
    "%s draws the composer's chip once the session carried the kind",
    (_source, read) => {
      const reference = read();
      if (reference === null) {
        throw new Error("Expected a reference");
      }
      const sessionFacts = facts({
        hint: { kind: "task", mimeType: null },
        matter: { status: "resolved", value: { color: "--option-red" } },
      });
      expect(resolveReferenceVisual(reference, sessionFacts)).toEqual({
        type: "chip",
        glyph: {
          type: "entity",
          source: { type: "resolved", kind: "task", mimeType: null },
        },
        matter: {
          type: "resolved",
          matterId: MATTER_ID,
          color: "--option-red",
        },
        label: "Call the counterparty",
      });
    },
  );

  test("the optimistic message links the mention the way the server persists it", () => {
    expect(mentionAttrsToHref(COMPOSER_ATTRS)).toBe(
      `#stella-entity=${MATTER_ID}:${TASK_ID}`,
    );
    expect(
      mentionAttrsToHref({ ...COMPOSER_ATTRS, sourceWorkspaceId: null }),
    ).toBe(`#stella-entity=${TASK_ID}`);
    expect(
      mentionAttrsToHref({
        id: MATTER_ID,
        label: "Matter A",
        category: "workspace",
      }),
    ).toBe(`#stella-workspace=${MATTER_ID}`);
    expect(
      mentionAttrsToHref({
        id: "dec-1",
        label: "Ns 1/2",
        category: "decision",
      }),
    ).toBe("#stella-decision=dec-1");
    expect(
      entityReferenceHref({ entityId: TASK_ID, matterId: MATTER_ID }),
    ).toBe(`#stella-entity=${MATTER_ID}:${TASK_ID}`);
  });
});

describe("which glyph a reference gets", () => {
  const persisted = referenceOf(
    referenceFromHref(`#stella-entity=${MATTER_ID}:${TASK_ID}`, "Lease.docx"),
  );
  const composer = referenceFromMentionAttrs({
    ...COMPOSER_ATTRS,
    kind: "document",
    mimeType: "application/pdf",
  });
  if (composer === null) {
    throw new Error("Expected a composer reference");
  }

  const glyphOf = (reference: ChatReference, live: ReferenceLiveFacts) => {
    const visual = resolveReferenceVisual(reference, live);
    return visual.type === "chip" ? visual.glyph : null;
  };

  test("a carried kind draws at once, before any read returns", () => {
    expect(glyphOf(composer, PENDING_FACTS)).toEqual({
      type: "entity",
      source: {
        type: "resolved",
        kind: "document",
        mimeType: "application/pdf",
      },
    });
  });

  test("a read refreshes what the source carried", () => {
    expect(
      glyphOf(
        composer,
        facts({
          entity: {
            status: "resolved",
            value: { kind: "folder", fileName: null, mimeType: null },
          },
        }),
      ),
    ).toEqual({
      type: "entity",
      source: {
        type: "resolved",
        kind: "folder",
        fileName: null,
        mimeType: null,
      },
    });
  });

  test("a source with no kind waits on the read instead of guessing from the label", () => {
    expect(glyphOf(persisted, PENDING_FACTS)).toEqual({
      type: "entity",
      source: { type: "pending" },
    });
    expect(
      glyphOf(persisted, facts({ entity: { status: "missing" } })),
    ).toEqual({ type: "entity", source: { type: "unknown" } });
  });

  test("a session hint stands in for a kind the persisted href dropped", () => {
    expect(
      glyphOf(persisted, facts({ hint: { kind: "task", mimeType: null } })),
    ).toEqual({
      type: "entity",
      source: { type: "resolved", kind: "task", mimeType: null },
    });
  });

  test("matters, decisions, skills and people get their own glyph", () => {
    const matter = referenceOf(
      referenceFromHref(`#stella-workspace=${MATTER_ID}`, "Matter A"),
    );
    const decision = referenceOf(
      referenceFromHref("#stella-decision=dec-1", "Ns 1/2"),
    );
    const skill = referenceOf(
      referenceFromHref("#stella-skill-ref=nda-review", "NDA review"),
    );
    const person = referenceOf(
      referenceFromHref(`#stella-user=${USER_ID}`, "Jan Kubica"),
    );

    expect(glyphOf(matter, PENDING_FACTS)).toEqual({ type: "matter" });
    expect(glyphOf(decision, PENDING_FACTS)).toEqual({ type: "decision" });
    expect(glyphOf(skill, PENDING_FACTS)).toEqual({ type: "skill" });
    // A person draws from the name the message already shows, then from the
    // organization's record.
    expect(glyphOf(person, PENDING_FACTS)).toEqual({
      type: "user",
      name: "Jan Kubica",
      image: null,
      deleted: false,
    });
    expect(
      glyphOf(
        person,
        facts({
          user: {
            status: "resolved",
            value: {
              name: "Jan Kubica",
              image: "https://a/b.png",
              deleted: false,
            },
          },
        }),
      ),
    ).toEqual({
      type: "user",
      name: "Jan Kubica",
      image: "https://a/b.png",
      deleted: false,
    });
  });
});

describe("where the matter colour comes from", () => {
  const task = referenceOf(
    referenceFromHref(`#stella-entity=${MATTER_ID}:${TASK_ID}`, "Task"),
  );
  const matterOf = (reference: ChatReference, live: ReferenceLiveFacts) => {
    const visual = resolveReferenceVisual(reference, live);
    return visual.type === "chip" ? visual.matter : null;
  };

  test("the stored colour of the reference's own matter", () => {
    expect(
      matterOf(
        task,
        facts({ matter: { status: "resolved", value: { color: "#AA3300" } } }),
      ),
    ).toEqual({ type: "resolved", matterId: MATTER_ID, color: "#AA3300" });
  });

  test("the matter's swatch when the matter list does not hold it", () => {
    expect(matterOf(task, facts({ matter: { status: "missing" } }))).toEqual({
      type: "resolved",
      matterId: MATTER_ID,
      color: null,
    });
  });

  test("no colour until the matter list answers, rather than a wrong one", () => {
    expect(matterOf(task, PENDING_FACTS)).toEqual({ type: "pending" });
  });

  test("an entity with no known matter, and non-matter references, stay neutral", () => {
    const orphan = referenceOf(
      referenceFromHref(`#stella-entity=${TASK_ID}`, "Task"),
    );
    const decision = referenceOf(
      referenceFromHref("#stella-decision=dec-1", "Ns 1/2"),
    );
    expect(matterOf(orphan, PENDING_FACTS)).toEqual({ type: "none" });
    expect(matterOf(decision, PENDING_FACTS)).toEqual({ type: "none" });
  });
});

describe("references that must not look real", () => {
  test.each([
    UNRESOLVED_REFERENCE_HREF,
    "#stella-entity-ref=ent_99",
    `#stella-entity-ref=${MATTER_ID}:ent_99`,
    "#stella-workspace-ref=mat_3",
  ])("%s renders as its plain label", (href) => {
    expect(referenceFromHref(href, "Lease")).toEqual({ type: "unresolved" });
  });

  test("a person the organization does not list stays plain text", () => {
    const person = referenceOf(
      referenceFromHref(`#stella-user=${USER_ID}`, "jankubica96"),
    );
    expect(
      resolveReferenceVisual(person, facts({ user: { status: "missing" } })),
    ).toEqual({ type: "plain", label: "jankubica96" });
  });

  test.each(["https://example.test", "#folio:seq-1", "#stella-source=1"])(
    "%s is not a reference",
    (href) => {
      expect(referenceFromHref(href, "x")).toBeNull();
    },
  );
});

describe("labels and decisions", () => {
  test("an entity label drops a known file extension, nothing else", () => {
    expect(entityDisplayLabel("Lease.docx")).toBe("Lease");
    expect(entityDisplayLabel("Lease v2.PDF")).toBe("Lease v2");
    expect(entityDisplayLabel("Call Dr. Novak")).toBe("Call Dr. Novak");
    expect(entityDisplayLabel("Report.final")).toBe("Report.final");
  });

  test("a decision passage keeps its anchor and falls back to it as the label", () => {
    const href =
      "#stella-decision-passage=33333333-3333-4333-8333-333333333333:p-12";
    expect(referenceOf(referenceFromHref(href, ""))).toEqual({
      type: "decision",
      locator: { type: "ref", ref: "33333333-3333-4333-8333-333333333333" },
      anchorId: "p-12",
      label: "p-12",
    });
    expect(
      referenceOf(referenceFromHref(href, "the appeal fails")),
    ).toMatchObject({ label: "the appeal fails", anchorId: "p-12" });
  });

  test("an app decision page link is a decision reference", () => {
    const params = { country: "cz", court: "ns", slug: "ns-1-2" };
    expect(referenceFromDecisionRoute(params, "Ns 1/2")).toEqual({
      type: "decision",
      locator: { type: "route", params },
      anchorId: null,
      label: "Ns 1/2",
    });
  });
});
