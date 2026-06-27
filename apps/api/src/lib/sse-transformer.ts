import type { ChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary"

type StellaChunk =
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "tool-input-delta"; toolCallId: string; inputTextDelta: string }
  | { type: "tool-output-available"; toolCallId: string; output: string }
  | { type: "data-stella-anon-restorations"; data: { pairs: Array<{ original: string; placeholder: string }> } }
  | { type: "error"; errorText: string }

type OpencodePart =
  | { type: "text"; text: string; id?: string }
  | { type: "tool"; callId: string; state: "input-streaming" | "output-available"; input?: unknown; output?: string }

type OpencodeMessage = {
  info: { id: string; role: string }
  parts: OpencodePart[]
}

export async function* transformOpencodeToStellaSSE(
  opencodeStream: AsyncIterable<OpencodeMessage>,
  _thirdPartyBoundary: ChatThirdPartyBoundary,
): AsyncGenerator<StellaChunk> {
  for await (const { info, parts } of opencodeStream) {
    for (const part of parts) {
      if (part.type === "text") {
        yield { type: "text-delta", id: part.id ?? info.id, delta: part.text }
      } else if (part.type === "tool") {
        if (part.state === "input-streaming") {
          yield {
            type: "tool-input-delta",
            toolCallId: part.callId,
            inputTextDelta: JSON.stringify(part.input),
          }
        } else if (part.state === "output-available") {
          yield {
            type: "tool-output-available",
            toolCallId: part.callId,
            output: part.output ?? "",
          }
        }
      }
    }
  }
}
