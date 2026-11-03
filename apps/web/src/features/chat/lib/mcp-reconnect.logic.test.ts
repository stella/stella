import { describe, expect, test } from "bun:test";

import { normalizeUnicode } from "@stll/text-normalize";

import { toSafeId } from "@/lib/safe-id";

import {
  canMentionMcpConnection,
  matchBrokenMcpConnections,
  mcpReconnectDismissKey,
} from "./mcp-reconnect.logic";
import type { McpReconnectCandidate } from "./mcp-reconnect.logic";

const connection = {
  id: toSafeId<"mcpUserConnection">("00000000-0000-4000-8000-000000000001"),
  status: "needs_reauth",
  expiresAt: "2026-10-13T10:00:00.000Z",
  displayName: "Český rejstřík",
  slug: "cesky-rejstrik",
} as const satisfies McpReconnectCandidate;

describe("mentioned broken MCP connections", () => {
  test("matches composed and decomposed diacritics regardless of case", () => {
    expect(normalizeUnicode(connection.displayName, "NFD")).not.toBe(
      connection.displayName,
    );
    for (const text of [
      "Search ČESKÝ REJSTŘÍK please",
      "Search cesky rejstrik please",
      `Search ${normalizeUnicode(connection.displayName, "NFD")} please`,
    ]) {
      expect(matchBrokenMcpConnections(text, [connection])).toEqual([
        connection,
      ]);
    }
  });

  test("matches canonical Latin letter variants", () => {
    for (const { displayName, mention } of [
      { displayName: "Straße Archiv", mention: "STRASSE ARCHIV" },
      { displayName: "Wrocław Registry", mention: "WROCLAW REGISTRY" },
      { displayName: "Søren Records", mention: "SOREN RECORDS" },
      { displayName: "ﬁling Archive", mention: "FILING ARCHIVE" },
    ]) {
      const candidate = {
        ...connection,
        displayName,
        slug: "unrelated-server",
      };
      expect(matchBrokenMcpConnections(mention, [candidate])).toEqual([
        candidate,
      ]);
    }
  });

  test("rejected short text stays ineligible after Unicode decomposition", () => {
    const text = "법";
    const displayName = normalizeUnicode(text, "NFD");
    expect(Array.from(text)).toHaveLength(1);
    expect(Array.from(displayName)).toHaveLength(3);
    const candidate = { ...connection, displayName, slug: "unrelated-server" };
    expect(canMentionMcpConnection(text)).toBe(false);
    expect(matchBrokenMcpConnections(text, [candidate])).toEqual([]);
  });

  test("matches each slug separator variant without splitting display names", () => {
    for (const slug of ["legal-records", "legal_records"]) {
      const candidate = { ...connection, displayName: "Legal Records", slug };
      for (const text of [slug, "legal records", `(${slug}), please`]) {
        expect(matchBrokenMcpConnections(text, [candidate])).toEqual([
          candidate,
        ]);
      }
      for (const text of ["legal", "records", "legal archive records"]) {
        expect(matchBrokenMcpConnections(text, [candidate])).toEqual([]);
      }
    }
  });

  test("word boundaries exclude prefixes and suffixes in every script", () => {
    const candidate = { ...connection, displayName: "Atlas", slug: "atlas" };
    for (const adjacent of ["x", "é", "Ж", "字", "ا", "1", "_", "\u{10400}"]) {
      for (const text of [`${adjacent}atlas`, `atlas${adjacent}`]) {
        expect(matchBrokenMcpConnections(text, [candidate])).toEqual([]);
      }
    }
    for (const boundary of [" ", "\n", ".", "(", "@", "😀"]) {
      expect(
        matchBrokenMcpConnections(`${boundary}atlas${boundary}`, [candidate]),
      ).toEqual([candidate]);
    }
    expect(
      matchBrokenMcpConnections("atlasian then atlas", [candidate]),
    ).toEqual([candidate]);
  });

  test("requires three Unicode characters in the whole alias", () => {
    for (const name of ["", "  ", "AI", "Čé", "字形", "😀😀"]) {
      const candidate = { ...connection, displayName: name, slug: name };
      expect(matchBrokenMcpConnections(name, [candidate])).toEqual([]);
    }
    const candidate = { ...connection, displayName: "字形集", slug: "abc" };
    expect(matchBrokenMcpConnections("字形集", [candidate])).toEqual([
      candidate,
    ]);
  });

  test("punctuation in connector names is literal", () => {
    const candidate = {
      ...connection,
      displayName: "A+B (Legal)",
      slug: "a.b",
    };
    for (const text of ["A+B (Legal)", "a.b"]) {
      expect(matchBrokenMcpConnections(text, [candidate])).toEqual([candidate]);
    }
    for (const text of ["AB Legal", "axb"]) {
      expect(matchBrokenMcpConnections(text, [candidate])).toEqual([]);
    }
  });

  test("includes all broken statuses and excludes healthy connections", () => {
    for (const { status } of [
      { status: "needs_reauth" },
      { status: "revoked" },
      { status: "needs_approval" },
    ] as const) {
      const candidate = { ...connection, status };
      expect(matchBrokenMcpConnections(connection.slug, [candidate])).toEqual([
        candidate,
      ]);
    }
    expect(
      matchBrokenMcpConnections(connection.slug, [
        { ...connection, status: "connected" },
      ]),
    ).toEqual([]);
  });

  test("returns every matched connection once in candidate order", () => {
    const second = {
      ...connection,
      id: toSafeId<"mcpUserConnection">("00000000-0000-4000-8000-000000000002"),
      displayName: "Court Archive",
      slug: "court_archive",
    };
    expect(
      matchBrokenMcpConnections(
        "Court Archive, court_archive and cesky rejstrik, cesky-rejstrik",
        [connection, second],
      ),
    ).toEqual([connection, second]);
    expect(matchBrokenMcpConnections("", [connection, second])).toEqual([]);
  });
});

describe("dismissal memory for one MCP break", () => {
  test("is stable for the same break regardless of connector metadata", () => {
    expect(mcpReconnectDismissKey(connection)).toBe(
      "00000000-0000-4000-8000-000000000001:needs_reauth:2026-10-13T10:00:00.000Z",
    );
    const renamed = { ...connection, displayName: "Renamed server" };
    expect(mcpReconnectDismissKey(renamed)).toBe(
      mcpReconnectDismissKey(connection),
    );
    expect(mcpReconnectDismissKey({ ...connection, expiresAt: null })).toBe(
      "00000000-0000-4000-8000-000000000001:needs_reauth:",
    );
  });

  test("a different connection, status or expiry creates a different break", () => {
    const originalKey = mcpReconnectDismissKey(connection);
    for (const candidate of [
      {
        ...connection,
        id: toSafeId<"mcpUserConnection">(
          "00000000-0000-4000-8000-000000000002",
        ),
      },
      { ...connection, status: "revoked" },
      { ...connection, status: "needs_approval" },
      { ...connection, expiresAt: "2026-10-14T10:00:00.000Z" },
      { ...connection, expiresAt: null },
    ] satisfies McpReconnectCandidate[]) {
      expect(mcpReconnectDismissKey(candidate)).not.toBe(originalKey);
    }
  });
});

describe("whether composer text can mention a connection", () => {
  test("needs as many non-space characters as the shortest matchable name", () => {
    for (const text of ["", "  ", "ab", " ab ", "č"]) {
      expect(canMentionMcpConnection(text)).toBe(false);
    }
    for (const text of ["abc", " abc ", "Čes"]) {
      expect(canMentionMcpConnection(text)).toBe(true);
    }
  });

  test("text it rejects never matches a connection", () => {
    const short = {
      ...connection,
      displayName: "Ab",
      slug: "ab",
    } satisfies McpReconnectCandidate;
    for (const text of ["ab", " Ab ", "a"]) {
      expect(canMentionMcpConnection(text)).toBe(false);
      expect(matchBrokenMcpConnections(text, [short, connection])).toEqual([]);
    }
    expect(canMentionMcpConnection("Český rejstřík")).toBe(true);
    expect(
      matchBrokenMcpConnections("Český rejstřík", [connection]),
    ).toHaveLength(1);
  });
});
