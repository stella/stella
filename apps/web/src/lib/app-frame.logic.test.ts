import { describe, expect, test } from "bun:test";

import { selectAppFrame } from "@/lib/app-frame.logic";

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
    // Still loading: the route's own pending shell shows, no frame yet.
    expect(
      selectAppFrame({
        routeIds: PROTECTED,
        hasRouteUser: false,
        publicKnowledge: true,
      }),
    ).toBe("none");
  });

  test("signed-in routes ignore the session state", () => {
    for (const audience of ["checking", "anonymous", "member"] as const) {
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
    ).toBe("none");
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
    const frame = (audience: "checking" | "anonymous" | "member") =>
      selectAppFrame({
        routeIds: KNOWLEDGE,
        hasRouteUser: false,
        publicKnowledge: true,
        audience,
      });
    expect(frame("checking")).toBe("checking");
    expect(frame("anonymous")).toBe("public");
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
