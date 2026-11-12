import { panic } from "better-result";
import { homedir } from "node:os";

import type { HarnessSkillFolder, HarnessTurn } from "./adapter";
import type {
  HarnessEvent,
  HarnessToolCall,
  HarnessToolResult,
} from "./events";

/**
 * What a turn sends to stella about its skill folders. A tool call's input and
 * result, and an approval's summary, are recorded as the run's messages, and a
 * skill is meant to stay on the member's computer. So a skill folder's path is
 * shown as `<skill:name>` wherever a harness reports it, and a call that
 * touched one reports its status and not what it read.
 *
 * This works from what the harness reports, so it cannot see what a call does
 * without naming a path (a `cd` in one call and a relative `cat` in the next),
 * or what the model writes in its own words.
 */

export type SkillPathScope = {
  folders: readonly HarnessSkillFolder[];
  /** The plugin that links to the folders, for a harness that needs one. */
  plugin: { dir: string; name: string } | null;
};

type Rule = { pattern: RegExp; replacement: string };

const escapeForPattern = (text: string) =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, (special) => `\\${special}`);

/** Every way a tool's text may spell one path. */
const spellings = (literal: string) => {
  const home = homedir();
  const homeRelative = literal.startsWith(`${home}/`)
    ? [`~${literal.slice(home.length)}`, `$HOME${literal.slice(home.length)}`]
    : [];
  return [
    ...new Set(
      [literal, ...homeRelative].flatMap((spelling) => [
        spelling,
        spelling.replaceAll("\\", "/"),
        // A result's content is JSON, which doubles a backslash.
        spelling.replaceAll("\\", "\\\\"),
        // As a shell writes a path with a space.
        spelling.replaceAll(" ", "\\ "),
      ]),
    ),
  ];
};

const WINDOWS_DRIVE = /^[A-Za-z]:/u;

const rulesFor = ({ folders, plugin }: SkillPathScope): Rule[] => {
  const shown = folders.flatMap(({ name, path }) => [
    { literal: path, replacement: `<skill:${name}>` },
    ...(plugin === null
      ? []
      : [
          {
            literal: `${plugin.dir}/skills/${name}`,
            replacement: `<skill:${name}>`,
          },
          {
            literal: `${plugin.dir}\\skills\\${name}`,
            replacement: `<skill:${name}>`,
          },
          {
            literal: `${plugin.name}:${name}`,
            replacement: `<skill:${name}>`,
          },
        ]),
  ]);
  return (
    plugin === null
      ? shown
      : [...shown, { literal: plugin.dir, replacement: "<skill:plugin>" }]
  )
    .toSorted((one, other) => other.literal.length - one.literal.length)
    .flatMap(({ literal, replacement }) =>
      spellings(literal).map((spelling) => ({
        // Not a longer name that merely starts the same; a full stop that
        // ends a sentence is not part of a name.
        pattern: new RegExp(
          `${escapeForPattern(spelling)}(?![\\w-]|\\.[\\w.-])`,
          WINDOWS_DRIVE.test(spelling) ? "giu" : "gu",
        ),
        replacement,
      })),
    );
};

const createRedactor = (scope: SkillPathScope) => {
  const rules = rulesFor(scope);
  /** Calls known to have touched a skill, by id, for their later events. */
  const touched = new Set<string>();

  const text = (value: string) => {
    let current = value;
    for (const { pattern, replacement } of rules) {
      current = current.replaceAll(pattern, () => replacement);
    }
    return current;
  };

  const anything = (value: unknown): unknown => {
    if (typeof value === "string") {
      return text(value);
    }
    if (Array.isArray(value)) {
      return value.map(anything);
    }
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, anything(entry)]),
      );
    }
    return value;
  };

  const mentions = (value: string) => text(value) !== value;

  const changes = (value: unknown) =>
    JSON.stringify(anything(value)) !== JSON.stringify(value);

  const toolCall = ({
    localInput,
    ...call
  }: HarnessToolCall): HarnessToolCall => {
    if (changes(call.input) || changes(localInput)) {
      touched.add(call.id);
    }
    return { ...call, input: anything(call.input) };
  };

  const result = (id: string, outcome: HarnessToolResult): HarnessToolResult =>
    touched.has(id) || mentions(outcome.content)
      ? {
          content: JSON.stringify({
            status: outcome.status === "failed" ? "failed" : "completed",
          }),
          status: outcome.status,
        }
      : outcome;

  return (event: HarnessEvent): HarnessEvent => {
    switch (event.type) {
      case "tool.started":
        return { ...event, toolCall: toolCall(event.toolCall) };
      case "tool.completed": {
        const call = toolCall(event.toolCall);
        return {
          ...event,
          toolCall: call,
          result: result(call.id, event.result),
        };
      }
      case "approval.requested":
        return {
          ...event,
          request: {
            ...event.request,
            toolCall: toolCall(event.request.toolCall),
            reason:
              event.request.reason === null ? null : text(event.request.reason),
          },
        };
      case "question.requested":
        return {
          ...event,
          request: {
            ...event.request,
            toolCall: toolCall(event.request.toolCall),
            // An option's label is also the answer the harness takes back, so
            // it stays as asked; the text around it is shown, not answered.
            questions: event.request.questions.map((question) => ({
              ...question,
              header: text(question.header),
              prompt: text(question.prompt),
              options: question.options.map((option) => ({
                ...option,
                description: text(option.description),
              })),
            })),
          },
        };
      case "retrying":
        return { ...event, message: text(event.message) };
      case "turn.failed":
        return {
          ...event,
          failure: {
            ...event.failure,
            message: text(event.failure.message),
          },
        };
      case "session.started":
        return event.continuation.type === "resume_unavailable"
          ? {
              ...event,
              continuation: {
                ...event.continuation,
                message: text(event.continuation.message),
              },
            }
          : event;
      case "text.delta":
      case "text.completed":
      case "reasoning.completed":
      case "interaction.resolved":
      case "turn.completed":
      case "turn.interrupted":
        return event;
      default:
        event satisfies never;
        return panic("Unhandled harness event");
    }
  };
};

/** The one filter both adapters put over a turn's events. */
export const redactingSkillPaths = (
  turn: HarnessTurn,
  scope: SkillPathScope,
): HarnessTurn => {
  if (scope.folders.length === 0) {
    return turn;
  }
  const redact = createRedactor(scope);
  const events = async function* () {
    for await (const event of turn.events) {
      yield redact(event);
    }
  };
  return {
    events: events(),
    respond: turn.respond,
    interrupt: turn.interrupt,
    release: turn.release,
    dispose: turn.dispose,
  };
};
