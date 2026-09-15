import type { ChatAnonResult } from "@stll/anonymize-chat";
import type { GazetteerEntry } from "@stll/anonymize-wasm";

export type AnonymizeChatWorkerRequest = {
  id: number;
  locale?: string | undefined;
  text: string;
  workspaceId: string;
  gazetteerEntries?: GazetteerEntry[];
  excludedCanonicals?: readonly string[];
};

export type AnonymizeChatWorkerResponse =
  | { id: number; ok: true; result: ChatAnonResult }
  | { id: number; ok: false; error: string };
