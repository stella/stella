import { useChatEditor } from "@/components/chat-editor-provider";
import { getLiveEditor } from "@/components/live-editor";

export const Composer = () => {
  const controller = useChatEditor({});
  const editor = getLiveEditor(controller.editor);
  // expect-clean: no-unsafe-controller-editor-access/no-unsafe-controller-editor-access
  editor?.getText();
  editor?.commands.clearContent();

  // oxlint-disable-next-line no-unsafe-controller-editor-access/no-unsafe-controller-editor-access -- fixture proves raw controller text access is rejected
  controller.editor?.getText();
  // oxlint-disable-next-line no-unsafe-controller-editor-access/no-unsafe-controller-editor-access -- fixture proves raw controller command access is rejected
  controller.editor?.commands.clearContent();
  return null;
};
