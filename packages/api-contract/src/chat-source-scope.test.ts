import { describe, expect, test } from "bun:test";

import {
  chatSourceScopeKey,
  formatChatSourceScopeId,
  parseChatSourceScopeHref,
  parseChatSourceScopeId,
  toChatSourceScopeHref,
} from "./chat-source-scope";
import type { ChatSourceScope } from "./chat-source-scope";

const SCOPES = [
  { kind: "corpus", corpus: "case_law", country: "CZE" },
  { kind: "corpus", corpus: "legislation", country: "SVK" },
  { kind: "registry", registry: "ares" },
  { kind: "registry", registry: "companies-house" },
  { kind: "connector", connector: "global-legal-search" },
  { kind: "connector", connector: "my_server-2" },
] as const satisfies readonly ChatSourceScope[];

describe("chat source chip ids and links", () => {
  test.each(SCOPES)("round-trips %p through its id and its link", (scope) => {
    expect(
      parseChatSourceScopeId(scope.kind, formatChatSourceScopeId(scope)),
    ).toEqual(scope);
    expect(parseChatSourceScopeHref(toChatSourceScopeHref(scope))).toEqual(
      scope,
    );
  });

  test("spells each kind's link with its own prefix", () => {
    expect(
      SCOPES.map((scope) => toChatSourceScopeHref(scope)).slice(1, 5),
    ).toEqual([
      "#stella-corpus=legislation:SVK",
      "#stella-registry=ares",
      "#stella-registry=companies-house",
      "#stella-connector=global-legal-search",
    ]);
  });

  test("keys a source by kind, so a registry and a connector sharing a slug stay apart", () => {
    expect(chatSourceScopeKey({ kind: "registry", registry: "ares" })).not.toBe(
      chatSourceScopeKey({ kind: "connector", connector: "ares" }),
    );
  });

  test.each([
    ["registry", "ARES"],
    ["registry", "not-a-registry"],
    ["registry", ""],
    ["connector", ""],
    ["connector", "Has Space"],
    ["connector", "-leading-dash"],
    ["connector", "x".repeat(81)],
    ["corpus", "case_law:XXX"],
  ] as const)("rejects %p id %p", (kind, id) => {
    expect(parseChatSourceScopeId(kind, id)).toBeNull();
  });

  test.each([
    "#stella-registry=nope",
    "#stella-connector=Bad Slug",
    "#stella-workspace=ws_1",
    "https://example.com",
  ])("reads no scope from %p", (href) => {
    expect(parseChatSourceScopeHref(href)).toBeNull();
  });
});
