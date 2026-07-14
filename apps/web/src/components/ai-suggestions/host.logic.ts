import type { FileAIChatStatus } from "./types";

type PromptBarBusyPlaceholderOptions = {
  isEmpty: boolean;
  queueWhileGenerating: boolean;
  status: FileAIChatStatus;
};

export const shouldShowPromptBarBusyPlaceholder = ({
  isEmpty,
  queueWhileGenerating,
  status,
}: PromptBarBusyPlaceholderOptions): boolean =>
  isEmpty &&
  (status === "applying" || (status === "generating" && !queueWhileGenerating));
