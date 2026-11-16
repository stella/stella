import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  MOBILE_PUSH_DATA_KEY,
  mobilePushDataSchema,
} from "@stll/api-contract/mobile-push";
import { NOTIFICATION_KINDS } from "@stll/api-contract/notifications";
import type { NotificationKind } from "@stll/api-contract/notifications";
import { UI_LOCALES } from "@stll/locales";

import { buildMobilePushPayload } from "@/api/lib/push/push-payload";
import type { PushNotificationPointer } from "@/api/lib/push/push-payload";

/**
 * What a notification's metadata holds for each kind: names of people,
 * workflows and announcements. None of it may reach an alert.
 */
const PRIVILEGED_TEXT = [
  "Novák v. Dvořák",
  "Ada Lovelace",
  "Acquisition due diligence",
  "Strictly confidential: merger with Initech",
];

const pointer = (kind: NotificationKind): PushNotificationPointer => ({
  id: "0198f7c4-0000-7000-8000-000000000001",
  kind,
  organizationId: "org-1",
  workspaceId: kind === "announcement" ? null : "ws-1",
  entityType: kind === "announcement" ? null : "entity",
  entityId: kind === "announcement" ? null : "entity-1",
});

describe("mobile push payload", () => {
  test.each(NOTIFICATION_KINDS)(
    "a %s alert is a fixed sentence in every language, naming nothing",
    (kind) => {
      const bodies = UI_LOCALES.map(
        (locale) =>
          buildMobilePushPayload({
            notification: pointer(kind),
            locale,
            unreadCount: 1,
          }).aps.alert.body,
      );
      for (const body of bodies) {
        expect(body.trim().length).toBeGreaterThan(0);
        // No placeholder survived, and none was ever filled.
        expect(body).not.toMatch(/[{}<>]/u);
        for (const text of PRIVILEGED_TEXT) {
          expect(body).not.toContain(text);
        }
      }
    },
  );

  test("the whole payload carries only the kind's sentence and opaque ids", () => {
    const payload = buildMobilePushPayload({
      notification: pointer("mention"),
      locale: "en",
      unreadCount: 3,
    });

    expect(payload).toEqual({
      aps: {
        alert: { body: "You were mentioned in a comment" },
        sound: "default",
        badge: 3,
      },
      [MOBILE_PUSH_DATA_KEY]: {
        v: 1,
        kind: "mention",
        notificationId: "0198f7c4-0000-7000-8000-000000000001",
        organizationId: "org-1",
        workspaceId: "ws-1",
        entityType: "entity",
        entityId: "entity-1",
      },
    });
    const serialized = JSON.stringify(payload);
    for (const text of PRIVILEGED_TEXT) {
      expect(serialized).not.toContain(text);
    }
    // The app reads its data with the shared schema.
    expect(
      v.safeParse(mobilePushDataSchema, payload[MOBILE_PUSH_DATA_KEY]).success,
    ).toBe(true);
  });

  test("the device's language picks the text, falling back to English", () => {
    const body = (locale: string) =>
      buildMobilePushPayload({
        notification: pointer("flow_run_awaiting_approval"),
        locale,
        unreadCount: null,
      }).aps.alert.body;

    expect(body("cs")).toBe("Pracovní postup čeká na vaše schválení");
    expect(body("cs-CZ")).toBe(body("cs"));
    expect(body("de_AT")).toBe(body("de"));
    expect(body("pt-PT")).toBe(body("pt-BR"));
    expect(body("ja-JP")).toBe("A workflow is waiting for your approval");
  });

  test("the badge is omitted when unknown and bounded when large", () => {
    const badge = (unreadCount: number | null) =>
      buildMobilePushPayload({
        notification: pointer("report_export_succeeded"),
        locale: "en",
        unreadCount,
      }).aps.badge;

    expect(badge(null)).toBeUndefined();
    expect(badge(0)).toBe(0);
    expect(badge(12_345)).toBe(999);
  });

  test("an announcement points at nothing", () => {
    const payload = buildMobilePushPayload({
      notification: pointer("announcement"),
      locale: "en",
      unreadCount: 1,
    });
    expect(payload.aps.alert.body).toBe(
      "Your organization posted an announcement",
    );
    expect(payload[MOBILE_PUSH_DATA_KEY]).toMatchObject({
      workspaceId: null,
      entityType: null,
      entityId: null,
    });
  });
});
