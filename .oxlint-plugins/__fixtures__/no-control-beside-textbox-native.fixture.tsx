// Passive regression fixture for
// `no-control-beside-textbox/no-control-beside-textbox` under React Native's
// layout (`layout: "native"`).
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

import type { ReactNode } from "react";

type Box = (props: {
  children?: ReactNode;
  className?: string;
  horizontal?: boolean;
}) => ReactNode;

declare const View: Box;
declare const ScrollView: Box;
declare const Modal: Box;
declare const Pressable: (props: { children?: ReactNode }) => ReactNode;
declare const RoundButton: () => ReactNode;
declare const ComposerAttachMenu: () => ReactNode;
declare const Textarea: (props: { appearance?: "composer" }) => ReactNode;
declare const TextInput: (props: { multiline?: boolean }) => ReactNode;
declare const ComposerFrame: (props: {
  leading: ReactNode;
  text: ReactNode;
  trailing: ReactNode;
}) => ReactNode;

// --- Flagged: the field in a row beside its controls ---
export const _a = ({ idle }: { idle: boolean }) => (
  <View className="min-h-[54px] flex-row items-end gap-2 px-2 py-1.5">
    <ComposerAttachMenu />
    <View className="min-w-0 flex-1 py-2.25">
      {idle ? (
        // oxlint-disable-next-line no-control-beside-textbox/no-control-beside-textbox
        <Textarea />
      ) : null}
    </View>
    <RoundButton />
  </View>
);
export const _b = () => (
  <ScrollView horizontal>
    {/* oxlint-disable-next-line no-control-beside-textbox/no-control-beside-textbox */}
    <TextInput multiline />
    <Pressable>Send</Pressable>
  </ScrollView>
);

// --- Accepted: a View is a column, so `flex` alone stacks ---
export const _c = () => (
  <View className="flex gap-2">
    <Textarea />
    <RoundButton />
  </View>
);
// --- Accepted: the text over a control row ---
export const _d = () => (
  <View className="pt-1.5">
    <View className="px-3.5">
      <Textarea />
    </View>
    <View className="flex-row justify-between">
      <ComposerAttachMenu />
      <RoundButton />
    </View>
  </View>
);
// --- Accepted: a single-line field, a modal, a field handed to a frame ---
export const _e = () => (
  <View className="flex-row gap-2">
    <TextInput />
    <Pressable>Search</Pressable>
  </View>
);
export const _f = () => (
  <View className="flex-row">
    <Modal>
      <Textarea />
    </Modal>
    <RoundButton />
  </View>
);
export const _g = () => (
  <ComposerFrame
    leading={<ComposerAttachMenu />}
    text={<Textarea appearance="composer" />}
    trailing={<RoundButton />}
  />
);
