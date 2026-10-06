import { describe, expect, test } from "bun:test";

import {
  frameVisitor,
  selectAppFrame,
  visitorChanged,
} from "@/routes/-app-frame.logic";
import type { AppFrameAudience } from "@/routes/-app-frame.logic";

const PROTECTED = ["__root__", "/_protected", "/_protected/chat/"];
const KNOWLEDGE = ["__root__", "/knowledge", "/knowledge/templates"];
const PUBLIC_LAW = ["__root__", "/law", "/law/"];

describe("selectAppFrame", () => {
  test("signed-in routes get the member frame once their guard has a user", () => {
    expect(
      selectAppFrame({
        routeIds: PROTECTED,
        hasRouteUser: true,
        publicKnowledge: true,
      }),
    ).toBe("member");
    // Still loading: the root owns the first shell while the guard resolves.
    expect(
      selectAppFrame({
        routeIds: PROTECTED,
        hasRouteUser: false,
        publicKnowledge: true,
      }),
    ).toBe("checking");
  });

  test("signed-in routes ignore the session state", () => {
    for (const audience of [
      "checking",
      "anonymous",
      "unavailable",
      "member",
    ] as const) {
      expect(
        selectAppFrame({
          routeIds: PROTECTED,
          hasRouteUser: true,
          publicKnowledge: true,
          audience,
        }),
      ).toBe("member");
    }
  });

  test("with Knowledge behind sign-in it behaves like any signed-in route", () => {
    expect(
      selectAppFrame({
        routeIds: KNOWLEDGE,
        hasRouteUser: true,
        publicKnowledge: false,
      }),
    ).toBe("member");
    expect(
      selectAppFrame({
        routeIds: KNOWLEDGE,
        hasRouteUser: false,
        publicKnowledge: false,
        audience: "anonymous",
      }),
    ).toBe("checking");
  });

  test("Knowledge for everyone asks for the session first", () => {
    expect(
      selectAppFrame({
        routeIds: KNOWLEDGE,
        hasRouteUser: false,
        publicKnowledge: true,
      }),
    ).toBe("unresolved");
  });

  test("Knowledge for everyone fails closed until the visitor is known", () => {
    const frame = (audience: AppFrameAudience) =>
      selectAppFrame({
        routeIds: KNOWLEDGE,
        hasRouteUser: false,
        publicKnowledge: true,
        audience,
      });
    expect(frame("checking")).toBe("checking");
    expect(frame("anonymous")).toBe("public");
    // A session that could not be read never opens the member frame.
    expect(frame("unavailable")).toBe("public");
    expect(frame("member")).toBe("member");
  });

  test("routes with their own shell get no frame", () => {
    for (const publicKnowledge of [true, false]) {
      expect(
        selectAppFrame({
          routeIds: PUBLIC_LAW,
          hasRouteUser: false,
          publicKnowledge,
          audience: "member",
        }),
      ).toBe("none");
    }
  });
});

const MEMBER_A = { userId: "user-1", organizationId: "org-a" };
const MEMBER_B = { userId: "user-1", organizationId: "org-b" };

describe("frameVisitor", () => {
  test("names a member by user and organization, and anyone else as anonymous", () => {
    expect(frameVisitor("member", MEMBER_A)).toBe("member:user-1:org-a");
    expect(frameVisitor("member", MEMBER_B)).not.toBe(
      frameVisitor("member", MEMBER_A),
    );
    expect(frameVisitor("public", undefined)).toBe("anonymous");
  });

  test("names nobody while the visitor is unknown or does not matter", () => {
    expect(frameVisitor("member", undefined)).toBeNull();
    for (const frame of ["checking", "unresolved", "none"] as const) {
      expect(frameVisitor(frame, MEMBER_A)).toBeNull();
    }
  });
});

describe("visitorChanged", () => {
  const member = frameVisitor("member", MEMBER_A);
  const otherOrganization = frameVisitor("member", MEMBER_B);

  test("a member signing out, or switching organization, is a change", () => {
    for (const visitor of ["anonymous", otherOrganization]) {
      expect(
        visitorChanged({
          publicKnowledge: true,
          shownVisitor: member,
          visitor,
        }),
      ).toBe(true);
    }
  });

  test("the same visitor, the first one, or an unknown one is not", () => {
    expect(
      visitorChanged({
        publicKnowledge: true,
        shownVisitor: member,
        visitor: member,
      }),
    ).toBe(false);
    expect(
      visitorChanged({
        publicKnowledge: true,
        shownVisitor: null,
        visitor: member,
      }),
    ).toBe(false);
    expect(
      visitorChanged({
        publicKnowledge: true,
        shownVisitor: member,
        visitor: null,
      }),
    ).toBe(false);
  });

  test("without Knowledge for everyone nothing changes today's behaviour", () => {
    expect(
      visitorChanged({
        publicKnowledge: false,
        shownVisitor: member,
        visitor: otherOrganization,
      }),
    ).toBe(false);
  });
});

describe("pages that show the same to every visitor", () => {
  const CATALOGUE_ENTRIES = [
    ["__root__", "/knowledge", "/knowledge/tools_/$entry"],
    ["__root__", "/knowledge", "/knowledge/tools_/contribute"],
    [
      "__root__",
      "/knowledge",
      "/knowledge/templates_/catalogue/$packId/$templateId",
    ],
  ];

  test("render inside a neutral frame while the visitor is unknown", () => {
    for (const routeIds of CATALOGUE_ENTRIES) {
      expect(
        selectAppFrame({
          routeIds,
          hasRouteUser: false,
          publicKnowledge: true,
          audience: "checking",
        }),
      ).toBe("neutral");
      expect(
        selectAppFrame({
          routeIds,
          hasRouteUser: false,
          publicKnowledge: true,
          audience: "anonymous",
        }),
      ).toBe("public");
    }
  });

  test("a section page still shows only the skeleton", () => {
    expect(
      selectAppFrame({
        routeIds: KNOWLEDGE,
        hasRouteUser: false,
        publicKnowledge: true,
        audience: "checking",
      }),
    ).toBe("checking");
  });

  test("the neutral frame names no visitor", () => {
    expect(frameVisitor("neutral", MEMBER_A)).toBeNull();
  });
});
