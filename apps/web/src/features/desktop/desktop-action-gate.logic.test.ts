import { describe, expect, test } from "bun:test";
import { createTranslator } from "use-intl/core";

import { desktopPresenceSchema } from "@stll/api-contract/desktop-presence";
import type { DesktopPresence } from "@stll/api-contract/desktop-presence";

import messages from "@/i18n/langs/en.json";

import {
  DESKTOP_ACTION_LABELS,
  DESKTOP_ACTION_REASONS,
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

describe("desktop action presentation follows the presence contract", () => {
  test.each(
    desktopPresenceSchema.options.map(({ entries }) => entries.type.literal),
  )("%s gives signing and editing their required action", (presence) => {
    expect(translate(DESKTOP_ACTION_LABELS["sign-pdf"][presence])).toBe(
      EXPECTED_LABELS[presence].sign,
    );
    expect(translate(DESKTOP_ACTION_LABELS["edit-file"][presence])).toBe(
      EXPECTED_LABELS[presence].edit,
    );
  });

  test("installation explains the local certificate or editor requirement", () => {
    expect(translate(DESKTOP_ACTION_REASONS["sign-pdf"])).toBe(gate.signReason);
    expect(translate(DESKTOP_ACTION_REASONS["edit-file"])).toBe(
      gate.editReason,
    );
  });
});
