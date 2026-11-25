import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "composer-attachments-in-frame";
const IMPORTS = `import { ComposerFrame } from "@stll/ui/composer-frame";
import { ChatDraftAttachmentChips } from "@/components/chat/chat-draft-attachment-chips";
`;
const lint = async (body: string) =>
  await lintSingleRule(RULE, `${IMPORTS}${body}`, { sourcePath: "source.tsx" });

describe(RULE, () => {
  test("reports chips in a floating tray over the frame", async () => {
    // The docked bar's former shape: an absolute tray in the `above` slot.
    expect(
      await lint(`const a = (
  <ComposerFrame
    above={
      <div className="absolute inset-x-1 bottom-full">
        <ChatDraftAttachmentChips files={files} onExpand={expand} onRemove={remove} />
      </div>
    }
    ring="none"
    stature="compact"
    empty
    text={null}
  />
);`),
    ).toEqual([7]);
  });

  test("reports chips beside the frame, in another slot, or held in a variable", async () => {
    expect(
      await lint(`const a = (
  <div>
    <ChatDraftAttachmentChips files={files} onExpand={expand} onRemove={remove} />
    <ComposerFrame ring="none" stature="large" text={null} />
  </div>
);
const b = <ComposerFrame above={<ChatDraftAttachmentChips files={files} onExpand={expand} onRemove={remove} />} ring="none" stature="large" text={null} />;
const chips = <ChatDraftAttachmentChips files={files} onExpand={expand} onRemove={remove} />;
const c = <ComposerFrame attachments={<div><ChatDraftAttachmentChips files={files} onExpand={expand} onRemove={remove} /></div>} ring="none" stature="large" text={null} />;`),
    ).toEqual([5, 9, 10, 11]);
  });

  test("accepts chips written into the frame's attachments slot, behind a condition", async () => {
    expect(
      await lint(`const a = <ComposerFrame attachments={<ChatDraftAttachmentChips files={files} onExpand={expand} onRemove={remove} />} ring="none" stature="large" text={null} />;
const b = <ComposerFrame attachments={enabled && <ChatDraftAttachmentChips files={files} onExpand={expand} onRemove={remove} />} ring="none" stature="large" text={null} />;
const c = <ComposerFrame attachments={enabled ? <ChatDraftAttachmentChips files={files} onExpand={expand} onRemove={remove} /> : null} ring="none" stature="large" text={null} />;`),
    ).toEqual([]);
  });

  test("resolves both components through their imports", async () => {
    // Aliased imports are the same components; a local namesake is not.
    expect(
      await lintSingleRule(
        RULE,
        `import { ComposerFrame as Frame } from "@stll/ui/composer-frame";
import { ChatDraftAttachmentChips as Chips } from "./chat/chat-draft-attachment-chips";
const a = <Frame attachments={<Chips files={files} onExpand={expand} onRemove={remove} />} ring="none" stature="large" text={null} />;
const b = <div><Chips files={files} onExpand={expand} onRemove={remove} /></div>;
const ComposerFrame = ({ attachments }) => attachments;
const c = <ComposerFrame attachments={<Chips files={files} onExpand={expand} onRemove={remove} />} />;`,
        { sourcePath: "source.tsx" },
      ),
    ).toEqual([4, 6]);
    expect(
      await lintSingleRule(
        RULE,
        `const ChatDraftAttachmentChips = () => null;
const a = <div><ChatDraftAttachmentChips /></div>;`,
        { sourcePath: "source.tsx" },
      ),
    ).toEqual([]);
  });
});
