import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { stripUnicodeMarks } from "@stll/text-normalize";

import {
  canApproveIntegrationAuthorization,
  type IntegrationAuthorizationStatus,
  integrationStatus,
  matchesConnectionQuery,
} from "./connections.logic";

const PROPERTY_MAX_TEXT_PARTS = 20;
const PROPERTY_MAX_FIELDS = 6;
const searchTextArbitrary = fc
  .array(
    fc.constantFrom(
      "a",
      "C",
      "é",
      "e\u0301",
      "Č",
      "c\u030C",
      "ß",
      "ς",
      "😀",
      "\ud800",
      "\udc00",
      "\ufffd",
      "+",
      "[",
      " ",
      "\t",
    ),
    { maxLength: PROPERTY_MAX_TEXT_PARTS },
  )
  .map((parts) => parts.join(""));

const oldFold = (value: string): string =>
  stripUnicodeMarks(value, {
    form: "NFD",
    markClass: "combining",
  }).toLocaleLowerCase();

describe("integration approval", () => {
  test("approval requires permission and a pending review", () => {
    const statuses = [
      undefined,
      "not_required",
      "approved",
      "needs_reapproval",
    ] as const satisfies readonly (
      IntegrationAuthorizationStatus | undefined
    )[];
    for (const status of statuses) {
      expect(canApproveIntegrationAuthorization(false, status)).toBe(false);
      expect(canApproveIntegrationAuthorization(true, status)).toBe(
        status === "needs_reapproval",
      );
    }
  });
});

describe("connection search", () => {
  test("an empty or blank query matches every row", () => {
    expect(matchesConnectionQuery("", ["Claude"])).toBe(true);
    expect(matchesConnectionQuery("   ", ["Claude"])).toBe(true);
  });

  test("matching ignores case and accents", () => {
    expect(matchesConnectionQuery("cesky", ["Český katastr"])).toBe(true);
    expect(matchesConnectionQuery("KATASTR", ["Český katastr"])).toBe(true);
  });

  test("every word must appear, in any field", () => {
    expect(
      matchesConnectionQuery("drive firm", ["Document Drive", "Firm files"]),
    ).toBe(true);
    expect(matchesConnectionQuery("drive chat", ["Document Drive"])).toBe(
      false,
    );
  });

  test("missing fields are skipped", () => {
    expect(
      matchesConnectionQuery("harbrook", [null, undefined, "Harbrook"]),
    ).toBe(true);
  });

  test("matches punctuation literally and retains its existing NFD fold", () => {
    expect(matchesConnectionQuery("+", ["Drive + files"])).toBe(true);
    expect(matchesConnectionQuery("drive +", ["Drive files"])).toBe(false);
    expect(matchesConnectionQuery("strasse", ["Straße"])).toBe(false);
  });

  test("matches malformed surrogates as replacement characters and rejects half-astral queries", () => {
    expect(matchesConnectionQuery("\ufffd", ["broken\ud800text"])).toBe(true);
    expect(matchesConnectionQuery("\ud83d", ["😀"])).toBe(false);
    expect(matchesConnectionQuery("\ude00", ["😀"])).toBe(false);
  });

  test("connection search matches the previous NFD word predicate for generated Unicode inputs", () => {
    assertProperty(
      "connection search matches the previous NFD word predicate for generated Unicode inputs",
      fc.property(
        searchTextArbitrary,
        fc.array(
          fc.oneof(
            searchTextArbitrary,
            fc.constant(null),
            fc.constant(undefined),
          ),
          { maxLength: PROPERTY_MAX_FIELDS },
        ),
        (query, fields) => {
          const words = oldFold(query)
            .split(/\s+/u)
            .filter(Boolean)
            .map((word) => word.toWellFormed());
          const expected = words.every((word) =>
            oldFold(fields.filter(Boolean).join(" "))
              .toWellFormed()
              .includes(word),
          );
          expect(matchesConnectionQuery(query, fields)).toBe(expected);
        },
      ),
    );
  });
});

describe("integration status", () => {
  test("a server that needs no sign-in shows no status until used", () => {
    expect(
      integrationStatus({
        authType: "none",
        authorizationStatus: "not_required",
        connection: undefined,
      }),
    ).toBeNull();
  });

  test("a server that needs sign-in and has none reads as not connected", () => {
    expect(
      integrationStatus({
        authType: "oauth",
        authorizationStatus: "approved",
        connection: undefined,
      }),
    ).toEqual({
      tone: "neutral",
      labelKey: "common.notConnected",
    });
    expect(
      integrationStatus({
        authType: "bearer",
        authorizationStatus: "not_required",
        connection: {
          status: "revoked",
          enabled: true,
          responseDisposition: "normal",
        },
      }),
    ).toEqual({
      tone: "neutral",
      labelKey: "common.notConnected",
    });
  });

  test("an expired sign-in asks for a reconnect", () => {
    expect(
      integrationStatus({
        authType: "oauth",
        authorizationStatus: "approved",
        connection: {
          status: "needs_reauth",
          enabled: true,
          responseDisposition: "normal",
        },
      }),
    ).toEqual({ tone: "warning", labelKey: "knowledge.mcp.needsReauth" });
  });

  test("a connected server the user switched off says so", () => {
    expect(
      integrationStatus({
        authType: "oauth",
        authorizationStatus: "approved",
        connection: {
          status: "connected",
          enabled: false,
          responseDisposition: "normal",
        },
      }),
    ).toEqual({ tone: "neutral", labelKey: "settings.connections.turnedOff" });
  });

  test("a live connection reads as connected", () => {
    expect(
      integrationStatus({
        authType: "oauth",
        authorizationStatus: "approved",
        connection: {
          status: "connected",
          enabled: true,
          responseDisposition: "normal",
        },
      }),
    ).toEqual({ tone: "success", labelKey: "common.connected" });
  });

  test("shared re-approval is visible without this user's connection", () => {
    expect(
      integrationStatus({
        authType: "oauth",
        authorizationStatus: "needs_reapproval",
        connection: undefined,
      }),
    ).toEqual({ tone: "warning", labelKey: "knowledge.mcp.needsReapproval" });
  });

  test("shared re-approval takes priority over this user's connection state", () => {
    expect(
      integrationStatus({
        authType: "oauth",
        authorizationStatus: "needs_reapproval",
        connection: {
          status: "connected",
          enabled: true,
          responseDisposition: "normal",
        },
      }),
    ).toEqual({ tone: "warning", labelKey: "knowledge.mcp.needsReapproval" });
  });

  test("a pending personal approval also asks for re-approval", () => {
    expect(
      integrationStatus({
        authType: "oauth",
        authorizationStatus: "approved",
        connection: {
          status: "needs_approval",
          enabled: true,
          responseDisposition: "normal",
        },
      }),
    ).toEqual({ tone: "warning", labelKey: "knowledge.mcp.needsReapproval" });
  });
});
