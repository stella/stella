import { expect, test } from "bun:test";

import { createCleanupRunner } from "../src/transcribe/TranscribeCleanup";

type Answer = { instructions: string[]; markdown: string } | null;

/** A cleanup endpoint that answers only when the test says so. */
const endpoint = () => {
  const requests: {
    text: string;
    previous: string | null;
    answer: (value: Answer) => Promise<void>;
  }[] = [];
  const clean = async (_job: number, text: string, previous: string | null) =>
    await new Promise<Answer>((resolve) => {
      requests.push({
        text,
        previous,
        answer: async (value) => {
          resolve(value);
          // Let the runner take the answer and send the next part.
          await Promise.resolve();
          await Promise.resolve();
        },
      });
    });
  return { clean, requests };
};

// Each paragraph is past half of a part, so every part carries one.
const paragraph = (letter: string) => ({
  startMs: 0,
  text: letter.repeat(7000),
});

test("parts go one at a time, each after the answer before it", async () => {
  const { clean, requests } = endpoint();
  const runner = createCleanupRunner({ job: 1, autoStart: true, clean });
  let notified = 0;
  runner.subscribe(() => {
    notified += 1;
  });

  runner.attach({
    paragraphs: [paragraph("a"), paragraph("b")],
    finished: true,
  });
  expect(requests).toHaveLength(1);
  expect(runner.getSnapshot().parts.map((part) => part.status)).toEqual([
    "running",
  ]);

  await requests[0]?.answer({ instructions: [], markdown: "A" });
  expect(requests).toHaveLength(2);
  expect(requests[1]?.previous).toBe("A");
  expect(runner.getSnapshot().parts.map((part) => part.status)).toEqual([
    "done",
    "running",
  ]);

  await requests[1]?.answer(null);
  expect(requests).toHaveLength(2);
  expect(runner.getSnapshot().parts.map((part) => part.status)).toEqual([
    "done",
    "failed",
  ]);
  expect(notified).toBeGreaterThan(0);

  runner.retry(1);
  expect(requests).toHaveLength(3);
  await requests[2]?.answer({ instructions: [], markdown: "B" });
  expect(runner.getSnapshot().parts.map((part) => part.status)).toEqual([
    "done",
    "done",
  ]);
});

test("a repeated attach sends nothing twice, and nothing goes once detached", async () => {
  const { clean, requests } = endpoint();
  const runner = createCleanupRunner({ job: 1, autoStart: true, clean });
  const input = {
    paragraphs: [paragraph("a"), paragraph("b")],
    finished: true,
  };

  // Mounted, unmounted and mounted again, as StrictMode does.
  runner.attach(input)();
  const detach = runner.attach(input);
  expect(requests).toHaveLength(1);

  detach();
  await requests[0]?.answer({ instructions: [], markdown: "A" });
  expect(requests).toHaveLength(1);
  expect(runner.getSnapshot().parts.map((part) => part.status)).toEqual([
    "done",
  ]);
});

test("nothing goes before cleanup starts", () => {
  const { clean, requests } = endpoint();
  const runner = createCleanupRunner({ job: 1, autoStart: false, clean });
  runner.attach({ paragraphs: [paragraph("a")], finished: true });
  expect(requests).toHaveLength(0);

  runner.start();
  expect(runner.getSnapshot().started).toBe(true);
  expect(requests).toHaveLength(1);
});
