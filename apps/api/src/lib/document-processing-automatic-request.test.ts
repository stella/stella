import { expect, test } from "bun:test";

test("leaves automatic OCR delivery to the configured batch scheduler", async () => {
  const source = await Bun.file(
    new URL("document-processing-automatic-request.ts", import.meta.url),
  ).text();

  expect(source).not.toContain("enqueueDocumentProcessingRun");
  expect(source).not.toContain("automatic-document-ocr.enqueue");
  expect(source).toContain("configured batch scheduler releases");
});

test("ships the batch scheduler in the stock self-host deployment", async () => {
  const dockerfile = await Bun.file(
    new URL("../../Dockerfile", import.meta.url),
  ).text();
  const compose = await Bun.file(
    new URL("../../../../docker-compose.selfhost.yml", import.meta.url),
  ).text();

  expect(dockerfile).toContain("--outfile /app/scheduler.js");
  expect(dockerfile).toContain(
    "COPY --chown=stella:stella --from=builder /app/scheduler.js /app/scheduler.js",
  );
  expect(compose).toContain("scheduler:");
  expect(compose).toContain('command: ["bun", "/app/scheduler.js"]');
});
