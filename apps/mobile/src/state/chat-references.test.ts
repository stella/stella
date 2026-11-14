import { describe, expect, test } from "bun:test";

import { toChatSourceCitationHref } from "@stll/api-contract";
import { toSafeId } from "@stll/api-contract/safe-id";

import { chatTextReference, referenceTarget } from "./chat-references";
import type { ChatTextReference } from "./chat-references";

const MATTER = "0191a3c4-5e6f-7a8b-9c0d-1e2f3a4b5c6d";
const ENTITY = "0191a3c4-5e6f-7a8b-9c0d-1e2f3a4b5c6e";
const DECISION = "0191a3c4-5e6f-7a8b-9c0d-1e2f3a4b5c70";

const target = (href: string, label: string, matterId?: string) => {
  const reference = chatTextReference(href, label, matterId);
  return reference === undefined || reference === "unresolved"
    ? reference
    : referenceTarget(reference);
};

describe("where a reference in chat text opens", () => {
  test("a document named with its file type opens to its pages at once", () => {
    expect(
      target(`#stella-entity=${MATTER}:${ENTITY}`, "Lease 2024.pdf"),
    ).toEqual({
      type: "route",
      href: {
        pathname: "/document/[workspaceId]/[entityId]",
        params: { entityId: ENTITY, workspaceId: MATTER, name: "Lease 2024" },
      },
    });
  });

  test("an item whose name says nothing of its kind is read first", () => {
    expect(target(`#stella-entity=${MATTER}:${ENTITY}`, "Lease")).toEqual({
      type: "resolve",
      matterId: MATTER,
      entityId: ENTITY,
      name: "Lease",
    });
  });

  test("an item with no matter, in a thread with none, opens nothing", () => {
    expect(target(`#stella-entity=${ENTITY}`, "Lease")).toBeUndefined();
    expect(target(`#stella-entity=${ENTITY}`, "Lease", MATTER)).toEqual({
      type: "resolve",
      matterId: MATTER,
      entityId: ENTITY,
      name: "Lease",
    });
  });

  test("a matter opens to its items, and a decision to its text", () => {
    expect(target(`#stella-workspace=${MATTER}`, "Smith v Jones")).toEqual({
      type: "route",
      href: {
        pathname: "/matter/[workspaceId]",
        params: { workspaceId: MATTER, name: "Smith v Jones" },
      },
    });
    expect(target(`#stella-decision=${DECISION}`, "Pl. ÚS 1/23")).toEqual({
      type: "route",
      href: {
        pathname: "/law/[decisionId]",
        params: { decisionId: DECISION },
      },
    });
  });

  test("a decision named by its docket is found by a search", () => {
    expect(
      target("#stella-decision=Pl.%20%C3%9AS%201%2F23", "Pl. ÚS 1/23"),
    ).toEqual({ type: "find", docket: "Pl. ÚS 1/23" });
  });

  test("a person and a skill open nothing", () => {
    expect(target(`#stella-user=${ENTITY}`, "Jana")).toBeUndefined();
    expect(
      target("#stella-skill-ref=nda-review", "NDA review"),
    ).toBeUndefined();
  });

  test("a cited passage of a document opens that document", () => {
    const href = toChatSourceCitationHref({
      type: "pdf-bates",
      workspaceId: toSafeId<"workspace">(MATTER),
      entityId: toSafeId<"entity">(ENTITY),
      entityVersionId: toSafeId<"entityVersion">(DECISION),
      fieldId: toSafeId<"field">(DECISION),
      bates: "ABC-0001",
      pageNumber: 3,
    });
    expect(chatTextReference(href, "p. 3", undefined)).toEqual({
      kind: "entity",
      label: "p. 3",
      name: null,
      matterId: MATTER,
      entityId: ENTITY,
      mimeType: "application/pdf",
    } satisfies ChatTextReference);
    expect(target(href, "p. 3")).toEqual({
      type: "route",
      href: {
        pathname: "/document/[workspaceId]/[entityId]",
        params: { entityId: ENTITY, workspaceId: MATTER },
      },
    });
  });

  test("a link that names nothing in stella is no reference", () => {
    expect(chatTextReference("https://x.test", "x", undefined)).toBeUndefined();
    expect(
      chatTextReference("#stella-unresolved-ref", "draft", undefined),
    ).toBe("unresolved");
  });
});
