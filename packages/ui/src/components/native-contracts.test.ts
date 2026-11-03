// Every component with a React Native renderer (`<module>.native.tsx`, the
// `react-native` condition in package.json) shares one props contract with
// its web renderer (`<module>.shared.ts`). These checks are types: each line
// stops compiling when a renderer stops accepting a contract prop at the
// contract's type, so the two renderers cannot drift apart unnoticed. The
// native imports are type-only, so no React Native module loads under Bun.

import type { ComponentProps, JSXElementConstructor } from "react";

import { expect, test } from "bun:test";

import { type Button, BUTTON_SIZE_CONTENT } from "./button";
import type { Button as NativeButton } from "./button.native";
import { BUTTON_SIZES, type ButtonContract } from "./button.shared";
import type { Input } from "./input";
import type { Input as NativeInput } from "./input.native";
import type { InputContract } from "./input.shared";
import type { Loader } from "./loader";
import type { Loader as NativeLoader } from "./loader.native";
import type { LoaderContract } from "./loader.shared";
import type { MatterIcon } from "./matter-icon";
import type { MatterIcon as NativeMatterIcon } from "./matter-icon.native";
import type { MatterIconContract } from "./matter-icon.shared";
import type { Separator } from "./separator";
import type { Separator as NativeSeparator } from "./separator.native";
import type { SeparatorContract } from "./separator.shared";
import type { Sheet } from "./sheet";
import type { Sheet as NativeSheet } from "./sheet.native";
import type { SheetContract } from "./sheet.shared";
import type { Switch } from "./switch";
import type { Switch as NativeSwitch } from "./switch.native";
import type { SwitchContract } from "./switch.shared";
import type { Text } from "./text";
import type { Text as NativeText } from "./text.native";
import type { TextContract } from "./text.shared";
import type { Textarea } from "./textarea";
import type { Textarea as NativeTextarea } from "./textarea.native";
import type { TextareaContract } from "./textarea.shared";

// oxlint-disable-next-line typescript/no-explicit-any -- any props: the constraint only asks for a component
type AnyComponent = JSXElementConstructor<any>;

/** `true` when a renderer accepts every contract prop at the contract's type. */
type Accepts<Component extends AnyComponent, Contract> = [Contract] extends [
  ComponentProps<Component>,
]
  ? true
  : false;

// Each pair is [web, native]; a `true` stops compiling when that renderer no
// longer accepts the contract.
const CONTRACTS: Record<string, readonly [true, true]> = {
  button: [true, true] satisfies [
    Accepts<typeof Button, ButtonContract>,
    Accepts<typeof NativeButton, ButtonContract>,
  ],
  input: [true, true] satisfies [
    Accepts<typeof Input, InputContract>,
    Accepts<typeof NativeInput, InputContract>,
  ],
  loader: [true, true] satisfies [
    Accepts<typeof Loader, LoaderContract>,
    Accepts<typeof NativeLoader, LoaderContract>,
  ],
  "matter-icon": [true, true] satisfies [
    Accepts<typeof MatterIcon, MatterIconContract>,
    Accepts<typeof NativeMatterIcon, MatterIconContract>,
  ],
  separator: [true, true] satisfies [
    Accepts<typeof Separator, SeparatorContract>,
    Accepts<typeof NativeSeparator, SeparatorContract>,
  ],
  sheet: [true, true] satisfies [
    Accepts<typeof Sheet, SheetContract>,
    Accepts<typeof NativeSheet, SheetContract>,
  ],
  switch: [true, true] satisfies [
    Accepts<typeof Switch, SwitchContract>,
    Accepts<typeof NativeSwitch, SwitchContract>,
  ],
  text: [true, true] satisfies [
    Accepts<typeof Text, TextContract>,
    Accepts<typeof NativeText, TextContract>,
  ],
  textarea: [true, true] satisfies [
    Accepts<typeof Textarea, TextareaContract>,
    Accepts<typeof NativeTextarea, TextareaContract>,
  ],
};

test("each web and React Native renderer accepts its shared contract", () => {
  expect(Object.keys(CONTRACTS)).toHaveLength(9);
});

test("the web button sizes exactly the shared sizes", () => {
  expect(Object.keys(BUTTON_SIZE_CONTENT).toSorted()).toEqual(
    [...BUTTON_SIZES].toSorted(),
  );
});
