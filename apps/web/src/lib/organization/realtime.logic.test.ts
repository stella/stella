import { describe, expect, test } from "bun:test";

import {
  RESOURCE_TYPE,
  resourceSetUpdatedRealtimeEvent,
} from "@stll/api-contract";

import { contactsKeys } from "@/lib/contacts/queries";

import { organizationEventQueryKeys } from "./realtime.logic";

const ORGANIZATION = "organization-one";

const startsWith = (key: readonly unknown[], prefix: readonly unknown[]) =>
  prefix.every((part, index) => key[index] === part);

describe("organizationEventQueryKeys", () => {
  test("a contact set change refreshes every contact list and page of the organization", () => {
    const [refreshed, ...rest] = organizationEventQueryKeys(
      resourceSetUpdatedRealtimeEvent(RESOURCE_TYPE.CONTACT),
      ORGANIZATION,
    );

    expect(rest).toEqual([]);
    expect(refreshed).toBeDefined();
    if (refreshed === undefined) {
      return;
    }
    for (const key of [
      contactsKeys.lists(ORGANIZATION),
      contactsKeys.list(ORGANIZATION, { type: "person", q: "" }),
      contactsKeys.byId(ORGANIZATION, "contact-one"),
    ]) {
      expect(startsWith(key, refreshed)).toBe(true);
    }
    expect(startsWith(contactsKeys.lists("organization-two"), refreshed)).toBe(
      false,
    );
  });

  test("a resource type without an organization-wide view refreshes nothing", () => {
    expect(
      organizationEventQueryKeys(
        resourceSetUpdatedRealtimeEvent(RESOURCE_TYPE.ENTITY),
        ORGANIZATION,
      ),
    ).toEqual([]);
  });
});
