import { describe, expect, test } from "bun:test";

import type { RecapMessage } from "./thread-recap-transcript";
import {
  buildRecapTranscript,
  RECAP_TRANSCRIPT_MAX_CHARS,
} from "./thread-recap-transcript";

const textMessage = ({
  role,
  text,
}: {
  role: "assistant" | "user";
  text: string;
}): RecapMessage => ({
  role,
  parts: [{ type: "text", text }],
});

describe("chat thread recap transcript", () => {
  test("keeps short transcripts unchanged", () => {
    const transcript = buildRecapTranscript([
      textMessage({ role: "user", text: "Review this clause." }),
      textMessage({ role: "assistant", text: "The clause is broad." }),
    ]);

    expect(transcript).toBe(
      "User: Review this clause.\n\nAssistant: The clause is broad.",
    );
  });

  test("preserves the first user prompt without exceeding the transcript cap", () => {
    const firstPrompt = "Initial legal brief ".repeat(1000);
    const recentAnswer = "Recent analysis ".repeat(1000);

    const transcript = buildRecapTranscript([
      textMessage({ role: "user", text: firstPrompt }),
      textMessage({ role: "assistant", text: recentAnswer }),
    ]);

    expect(transcript.length).toBeLessThanOrEqual(RECAP_TRANSCRIPT_MAX_CHARS);
    expect(transcript).toStartWith("User: Initial legal brief");
    expect(transcript).toContain(" [...]");
    expect(transcript).toContain("[...]");
    expect(transcript).toContain("Assistant: ");
    expect(transcript).toContain("Recent analysis");
  });
});
