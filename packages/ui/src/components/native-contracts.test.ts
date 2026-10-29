// Every component with a React Native renderer (`<module>.native.tsx`, the
// `react-native` condition in package.json) shares one props contract with
// its web renderer (`<module>.shared.ts`). These checks are types: each line
// stops compiling when a renderer stops accepting a contract prop at the
// contract's type, so the two renderers cannot drift apart unnoticed. The
// imports are type-only, so no React Native module loads under Bun.

import type { ComponentProps, JSXElementConstructor } from "react";

import { expect, test } from "bun:test";

import type { Button } from "./button";
import type { Button as NativeButton } from "./button.native";
import type { ButtonContract } from "./button.shared";
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

/**
 * Compiles only when both renderers accept every contract prop: the call
 * takes no argument when they do, and an impossible one when they do not.
 */
const sharesContract = <
  Contract,
  Web extends AnyComponent,
  Native extends AnyComponent,
>(
  ..._unless: [Contract] extends [ComponentProps<Web>]
    ? [Contract] extends [ComponentProps<Native>]
      ? []
      : [never]
    : [never]
): true => true;

test("each web and React Native renderer accepts its shared contract", () => {
  expect([
    sharesContract<ButtonContract, typeof Button, typeof NativeButton>(),
    sharesContract<InputContract, typeof Input, typeof NativeInput>(),
    sharesContract<LoaderContract, typeof Loader, typeof NativeLoader>(),
    sharesContract<
      MatterIconContract,
      typeof MatterIcon,
      typeof NativeMatterIcon
    >(),
    sharesContract<
      SeparatorContract,
      typeof Separator,
      typeof NativeSeparator
    >(),
    sharesContract<SheetContract, typeof Sheet, typeof NativeSheet>(),
    sharesContract<SwitchContract, typeof Switch, typeof NativeSwitch>(),
    sharesContract<TextContract, typeof Text, typeof NativeText>(),
    sharesContract<TextareaContract, typeof Textarea, typeof NativeTextarea>(),
  ]).not.toContain(false);
});
