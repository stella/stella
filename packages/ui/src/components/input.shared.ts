// The text field's contract, shared by its two renderers: the web's
// (./input.tsx, an <input> through Base UI) and React Native's
// (./input.native.tsx, a TextInput). ./textarea.shared.ts is its multi-line
// sibling.

import type { ControlSize } from "../lib/control-size";

/** The props every text field renderer accepts, with one meaning. */
export type TextFieldContract = {
  size?: ControlSize;
  /** No box of its own, for a field inside a container that draws one. */
  unstyled?: boolean;
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  disabled?: boolean;
  /** The field's new text, as typed. */
  onValueChange?: (value: string) => void;
};

/** A single-line field also says what it holds; `search` draws a search field. */
export type InputContract = TextFieldContract & {
  type?: "email" | "search" | "tel" | "text" | "url";
};
