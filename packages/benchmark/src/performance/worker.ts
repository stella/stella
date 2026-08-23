const inputBytes = Number.parseInt(process.argv.at(2) ?? "", 10);
if (!Number.isSafeInteger(inputBytes) || inputBytes <= 0) {
  throw new Error("worker requires a positive input byte count");
}
const scenarioArgument = process.argv.at(3) ?? "";

process.stdout.write(`${JSON.stringify({ type: "ready" })}\n`);
const { buildPerformanceInput, parsePerformanceScenarioId } =
  await import("./input");
const scenarioId = parsePerformanceScenarioId(scenarioArgument);
const input = await buildPerformanceInput(inputBytes, scenarioId);
const initStartedMilliseconds = performance.now();
const { runPerformanceSample } = await import("./sample");
const sample = await runPerformanceSample({
  scenario: input.scenario,
  inputBytes,
  inputText: input.text,
  inputSha256: input.sha256,
  initStartedMilliseconds,
});
process.stdout.write(`${JSON.stringify({ type: "result", sample })}\n`);
