import { toJsonSchema } from "@valibot/to-json-schema";
import { expect, test } from "bun:test";
import * as v from "valibot";

import {
  desktopPresenceReportSchema,
  desktopPresenceSchema,
} from "./desktop-presence";
import fixture from "./desktop-presence-request.fixture.json";

test("observation timestamps have an explicit text bound", () => {
  const observation = {
    properties: {
      desktop: {
        properties: {
          version: { maxLength: 64 },
          lastSeenAt: { maxLength: 32 },
        },
      },
    },
  };
  expect(
    toJsonSchema(desktopPresenceSchema, { errorMode: "ignore" }),
  ).toMatchObject({
    oneOf: [
      observation,
      observation,
      observation,
      { properties: { type: { const: "none" } } },
    ],
  });
});

test("the desktop request fixture satisfies the API's report schema", () => {
  expect(v.parse(desktopPresenceReportSchema, fixture)).toEqual(fixture);
});

test("presence reports accept only bounded installation metadata", () => {
  for (const extra of [
    { userId: "other" },
    { organizationId: "other" },
    { lastSeenAt: "2030-01-01T00:00:00.000Z" },
    { name: "device" },
  ]) {
    expect(
      v.safeParse(desktopPresenceReportSchema, { ...fixture, ...extra })
        .success,
    ).toBe(false);
  }
  for (const invalid of [
    { desktopId: "bad" },
    { version: "garbage" },
    { protocol: -1 },
    { protocol: 1.5 },
    { protocol: 2_147_483_648 },
  ]) {
    expect(
      v.safeParse(desktopPresenceReportSchema, { ...fixture, ...invalid })
        .success,
    ).toBe(false);
  }
});

test("each known observation carries its version, protocol and last server observation", () => {
  const desktop = {
    version: fixture.version,
    protocol: fixture.protocol,
    lastSeenAt: "2026-10-05T08:00:00.000Z",
  };
  expect(v.parse(desktopPresenceSchema, { type: "none" })).toEqual({
    type: "none",
  });
  for (const type of ["current", "outdated", "not_connected"]) {
    expect(v.safeParse(desktopPresenceSchema, { type, desktop }).success).toBe(
      true,
    );
    expect(v.safeParse(desktopPresenceSchema, { type }).success).toBe(false);
  }
  expect(
    v.safeParse(desktopPresenceSchema, { type: "none", desktop }).success,
  ).toBe(false);
});
