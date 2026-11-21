import { describe, expect, test } from "bun:test";
import { createTranslator } from "use-intl/core";

import { desktopPresenceSchema } from "@stll/api-contract/desktop-presence";
import type { DesktopPresence } from "@stll/api-contract/desktop-presence";

import messages from "@/i18n/langs/en.json";

import {
  DESKTOP_ACTION_LABELS,
  DESKTOP_ACTION_REASONS,
  DESKTOP_SETUP_LABELS,
  getDesktopActionStatus,
} from "./desktop-action-gate.logic";

const gate = messages.workspaces.files.desktopGate;
const EXPECTED_LABELS = {
  current: {
    edit: messages.workspaces.files.desktopEdit.openAction,
    sign: gate.signCurrent,
  },
  outdated: { edit: gate.editOutdated, sign: gate.signOutdated },
  not_connected: { edit: gate.connect, sign: gate.connect },
  none: { edit: gate.editNone, sign: gate.signNone },
} as const satisfies Record<
  DesktopPresence["type"],
  { edit: string; sign: string }
>;

const translate = createTranslator({ locale: "en", messages });

const PRESENCES = desktopPresenceSchema.options.map(
  ({ entries }) => entries.type.literal,
);

describe("desktop action presentation follows the presence contract", () => {
  test.each(PRESENCES)(
    "%s gives signing and editing their required action",
    (presence) => {
      expect(translate(DESKTOP_ACTION_LABELS["sign-pdf"][presence])).toBe(
        EXPECTED_LABELS[presence].sign,
      );
      expect(translate(DESKTOP_ACTION_LABELS["edit-file"][presence])).toBe(
        EXPECTED_LABELS[presence].edit,
      );
    },
  );

  test("only a current app runs the action; every other presence names a distinct setup step", () => {
    const steps = PRESENCES.flatMap((presence) => {
      const status = getDesktopActionStatus(presence);
      expect(status.type === "ready").toBe(presence === "current");
      return status.type === "setup" ? [status.step] : [];
    });
    expect(new Set(steps).size).toBe(PRESENCES.length - 1);
  });

  test("each setup step reads as its own status line", () => {
    const labels = Object.values(DESKTOP_SETUP_LABELS).map((key) =>
      translate(key),
    );
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) {
      expect(label).toContain("stella desktop");
    }
  });

  test("installation explains the local certificate or editor requirement", () => {
    expect(translate(DESKTOP_ACTION_REASONS["sign-pdf"])).toBe(gate.signReason);
    expect(translate(DESKTOP_ACTION_REASONS["edit-file"])).toBe(
      gate.editReason,
    );
  });
});
