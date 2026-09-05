import { panic } from "better-result";

import { isClipboardGroupColor } from "./clipboard-types";
import type { ClipboardGroupColor } from "./clipboard-types";

const groupColor = (value: string): ClipboardGroupColor =>
  isClipboardGroupColor(value)
    ? value
    : panic(`Invalid clipboard group color: ${value}`);

export const CLIPBOARD_GROUP_COLOR_PRESETS = [
  groupColor("#a3a3a3"),
  groupColor("#60a5fa"),
  groupColor("#34d399"),
  groupColor("#fbbf24"),
  groupColor("#fb7185"),
  groupColor("#a78bfa"),
] as const satisfies readonly ClipboardGroupColor[];

export const DEFAULT_CLIPBOARD_GROUP_COLOR = CLIPBOARD_GROUP_COLOR_PRESETS[0];
