import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

// A condition on an event the workflow never receives is dead code: a step
// guarded by it never runs, while the workflow reads as if it covered that
// event. Reusable workflows are skipped; they run under their caller's event.
const WORKFLOWS = ".github/workflows";
const EVENT_NAME_TEST =
  /github\.event_name\s*[!=]=\s*'(?<single>[a-z_]+)'|contains\(fromJSON\('\[(?<list>[^\]]*)\]'\),\s*github\.event_name\)/gu;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const triggersOf = (on: unknown): Set<string> => {
  if (typeof on === "string") {
    return new Set([on]);
  }
  if (Array.isArray(on)) {
    return new Set(on.map(String));
  }
  return new Set(isRecord(on) ? Object.keys(on) : []);
};

export const namedEvents = (source: string): Set<string> => {
  const events = new Set<string>();
  for (const { groups } of source.matchAll(EVENT_NAME_TEST)) {
    if (groups?.["single"] !== undefined) {
      events.add(groups["single"]);
    }
    for (const event of groups?.["list"]?.split(",") ?? []) {
      events.add(event.replace(/["\s]/gu, ""));
    }
  }
  events.delete("");
  return events;
};

test("no workflow tests for an event it is never triggered by", () => {
  const dead: string[] = [];
  for (const file of readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith(".yml"))
    .toSorted()) {
    const source = readFileSync(`${WORKFLOWS}/${file}`, "utf-8");
    const workflow: unknown = Bun.YAML.parse(source);
    if (!isRecord(workflow)) {
      continue;
    }
    const triggers = triggersOf(workflow["on"]);
    if (triggers.has("workflow_call")) {
      continue;
    }
    for (const event of namedEvents(source)) {
      if (!triggers.has(event)) {
        dead.push(`${file}: ${event}`);
      }
    }
  }
  expect(dead).toEqual([]);
});

test("both condition forms name their events", () => {
  expect([
    ...namedEvents(
      "if: github.event_name == 'pull_request' || contains(fromJSON('[\"push\", \"schedule\"]'), github.event_name)",
    ),
  ]).toEqual(["pull_request", "push", "schedule"]);
});
