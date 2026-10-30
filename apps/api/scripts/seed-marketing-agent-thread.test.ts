import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  CHAT_SOURCE_CITATION_HREF_PREFIX,
  parseCanonicalChatSourceCitationHref,
} from "@stll/api-contract";
import { chatToolExecutor } from "@stll/api-contract/chat";
import {
  GENERATED_VISUAL_URI_PREFIX,
  generatedVisualInputSchema,
  generatedVisualPartSchema,
} from "@stll/api-contract/generated-visual";
import {
  VISUAL_PREVIEW_TOOL_NAME,
  visualPreviewToolOutputSchema,
} from "@stll/api-contract/visual-preview";
import { compareCodeUnit } from "@stll/collation";

import { chatMessageFromPersisted } from "@/api/handlers/chat/chat-message-parts";
import { RECAP_PROMPT_VERSION } from "@/api/handlers/chat/thread-recap";
import exposureView from "@/api/handlers/visual-sandbox/fixtures/showcase/change-of-control-exposure.json";
import { prepareGeneratedVisual } from "@/api/handlers/visual-sandbox/prepare";
import { toSafeId } from "@/api/lib/branded-types";

import {
  buildExportReviewCitationSeeds,
  buildExportReviewDocumentText,
  buildExportReviewMetadata,
  EXPORT_REVIEW_DOC_NAMES,
  exportReviewCitationBlockId,
  exportReviewDocumentIds,
} from "./seed-export-review";
import {
  aggregateChangeOfControlExposure,
  buildMarketingAgentThread,
  CHANGE_OF_CONTROL_POSITIONS,
  MARKETING_AGENT_QUESTIONS,
  MARKETING_AGENT_THREAD_TITLE,
  rankChangeOfControlExposure,
  RISK_SEVERITY,
} from "./seed-marketing-agent-thread";

const workspaceId = toSafeId<"workspace">(
  "bb8641dc-0667-574c-8e30-152a1fd4b3f5",
);
const build = () =>
  buildMarketingAgentThread({
    createdAt: new Date("2026-07-16T09:30:00.000Z"),
    organizationId: toSafeId<"organization">("test-org-stella-dev"),
    userId: "test-user-stella-dev",
    workspaceId,
  });

const reload = (row: ReturnType<typeof build>["messages"][number]) =>
  chatMessageFromPersisted({
    id: row.id,
    role: row.role,
    content: row.content,
  });

const textOf = (row: ReturnType<typeof build>["messages"][number]) =>
  reload(row)
    .parts.flatMap((part) => (part.type === "text" ? [part.content] : []))
    .join("\n");

const lastOf = <T>(items: readonly T[]): T => {
  const last = items.at(-1);
  if (last === undefined) {
    throw new TypeError("Expected a nonempty list");
  }
  return last;
};

const CITATION_LINK = /\[(?<label>[^\]]+)\]\((?<href>[^)\s]+)\)/gu;

const citationLinks = (text: string) =>
  Array.from(text.matchAll(CITATION_LINK), (match) => ({
    label: match.groups?.["label"] ?? "",
    href: match.groups?.["href"] ?? "",
  })).filter(({ href }) => href.startsWith(CHAT_SOURCE_CITATION_HREF_PREFIX));

describe("marketing agent thread", () => {
  test("is a finished three-turn conversation the API reloads unchanged", () => {
    const { messages, thread } = build();
    expect(thread.title).toBe(MARKETING_AGENT_THREAD_TITLE);
    expect(messages.map(({ role }) => role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(
      messages.filter(({ role }) => role === "user").map((row) => textOf(row)),
    ).toEqual([...MARKETING_AGENT_QUESTIONS]);
    for (const [index, row] of messages.entries()) {
      expect(row.content.version).toBe(3);
      expect(row.threadId).toBe(thread.id);
      const reloaded = reload(row);
      expect(reloaded.id).toBe(row.id);
      if (row.role === "assistant") {
        expect(reloaded.metadata?.turnOutcome).toEqual({ type: "completed" });
      }
      const previous = messages.at(index - 1);
      if (index > 0 && previous) {
        expect(row.createdAt.getTime()).toBeGreaterThan(
          previous.createdAt.getTime(),
        );
      }
    }
    expect(thread.updatedAt).toEqual(lastOf(messages).createdAt);
  });

  test("pins the recap to the last message so reopening spends no model call", () => {
    const { messages, thread } = build();
    expect(thread.recapMessageId).toBe(lastOf(messages).id);
    expect(thread.recapPromptVersion).toBe(RECAP_PROMPT_VERSION);
    expect(thread.recapText.length).toBeGreaterThan(0);
    expect(thread.recapText.length).toBeLessThanOrEqual(700);
  });

  test("every inline citation resolves to a seeded passage that states its quote", () => {
    const { messages } = build();
    const assistantTexts = messages
      .filter(({ role }) => role === "assistant")
      .map((row) => textOf(row));
    const links = assistantTexts.flatMap((text) => citationLinks(text));
    // Each answer cites its sources inline, not only in the source footer.
    for (const text of assistantTexts) {
      expect(citationLinks(text).length).toBeGreaterThan(0);
    }
    for (const { href, label } of links) {
      expect(label.trim().length).toBeGreaterThan(0);
      const target = parseCanonicalChatSourceCitationHref(href);
      if (target?.type !== "docx-folio") {
        throw new TypeError(`Not a canonical DOCX citation: ${href}`);
      }
      expect(target.workspaceId).toBe(workspaceId);
      const index = EXPORT_REVIEW_DOC_NAMES.findIndex(
        (_name, row) =>
          exportReviewDocumentIds(row).entityId === target.entityId,
      );
      expect(index).toBeGreaterThanOrEqual(0);
      const ids = exportReviewDocumentIds(index);
      expect(target.entityVersionId).toBe(ids.entityVersionId);
      expect(target.fieldId).toBe(ids.fileFieldId);
      const fileName = EXPORT_REVIEW_DOC_NAMES.at(index) ?? "";
      expect(fileName.endsWith(".docx")).toBe(true);
      const citationSeed = buildExportReviewCitationSeeds(
        buildExportReviewMetadata(index),
      ).find(({ quote }) => quote === target.text);
      if (!citationSeed) {
        throw new TypeError(`No citation seed quotes "${target.text}"`);
      }
      expect(target.blockId).toBe(exportReviewCitationBlockId(citationSeed));
      expect(
        buildExportReviewDocumentText(fileName, index).split("\n"),
      ).toContain(target.text);
    }
  });

  test("the first answer's table ranks every counterparty by position, severity and value", () => {
    const { messages } = build();
    const firstAnswer = messages.at(1);
    if (!firstAnswer) {
      throw new TypeError("The thread has no first answer");
    }
    const tableRows = textOf(firstAnswer)
      .split("\n")
      .filter((line) => line.startsWith("| ") && !line.startsWith("| ---"))
      .slice(1)
      .map((line) =>
        line.split(" | ").map((cell) => cell.replaceAll("|", "").trim()),
      );
    expect(
      tableRows.map((cells) => [cells.at(0), cells.at(2), cells.at(3)]),
    ).toEqual(
      rankChangeOfControlExposure(aggregateChangeOfControlExposure()).map(
        (row) => [
          row.name,
          row.risk,
          exposureView.data.labels.positions[row.position],
        ],
      ),
    );
    // The lead-ins cite the Critical agreements as leading the review, so
    // they head the table.
    expect(tableRows.map((cells) => cells.at(0))).toEqual([
      "Delta Logistics Kft.",
      "Helios Energy a.s.",
      "Granite Properties B.V.",
      "Cedar Cloud Ltd.",
      "BluePeak Manufacturing s.r.o.",
      "Fjord Analytics AB",
      "Aurora Retail GmbH",
      "Edison Bank plc",
    ]);
  });

  test("the final turn shows the stored generated view through a completed show_visual call", () => {
    const { messages, thread, visualFile } = build();
    const lastAnswer = messages.at(-1);
    if (!lastAnswer) {
      throw new TypeError("The thread has no final answer");
    }
    const parts = reload(lastAnswer).parts;
    expect(parts.map(({ type }) => type)).toEqual([
      "text",
      "tool-call",
      "ui-resource",
      "tool-result",
      "text",
    ]);
    const call = parts.find((part) => part.type === "tool-call");
    const resource = v.parse(
      generatedVisualPartSchema,
      parts.find((part) => part.type === "ui-resource"),
    );
    expect(call).toMatchObject({
      name: VISUAL_PREVIEW_TOOL_NAME,
      state: "complete",
      id: resource.toolCallId,
    });
    // show_visual runs on the server; persisted calls record who executes them.
    expect(chatToolExecutor(call)).toBe("server");
    expect(v.is(visualPreviewToolOutputSchema, call?.output)).toBe(true);
    expect(resource).toEqual(visualFile.part);
    expect(resource.resource.uri).toBe(
      `${GENERATED_VISUAL_URI_PREFIX}${visualFile.row.id}`,
    );
    expect(visualFile.row.threadId).toBe(lastAnswer.threadId);
    expect(String(visualFile.row.s3Key)).toBe(
      `${thread.organizationId}/${visualFile.row.id}.txt`,
    );
    expect(visualFile.row.sizeBytes).toBe(visualFile.bytes.byteLength);

    // Read the stored page back the way /v1/user-files/:fileId/visual does.
    const stored: unknown = JSON.parse(
      new TextDecoder().decode(visualFile.bytes),
    );
    const page = prepareGeneratedVisual(
      v.parse(generatedVisualInputSchema, stored),
    ).unwrap();
    expect(page.title).toBe(resource.resource.text);
    expect(page.data).toMatchObject({
      labels: exposureView.data.labels,
      positions: [...CHANGE_OF_CONTROL_POSITIONS],
      risks: [...RISK_SEVERITY],
    });
  });

  test("the stored view accounts for every seeded document exactly once", () => {
    const { visualFile } = build();
    const { counterparties } = v.parse(
      v.object({
        data: v.object({
          counterparties: v.array(
            v.object({
              name: v.string(),
              documents: v.number(),
              value: v.number(),
            }),
          ),
        }),
      }),
      JSON.parse(new TextDecoder().decode(visualFile.bytes)),
    ).data;
    const rows = EXPORT_REVIEW_DOC_NAMES.map((_name, index) =>
      buildExportReviewMetadata(index),
    );
    expect(
      counterparties.map(({ name }) => name).toSorted(compareCodeUnit),
    ).toEqual(
      [...new Set(rows.map(({ counterparty }) => counterparty))].toSorted(
        compareCodeUnit,
      ),
    );
    expect(
      counterparties.reduce((sum, { documents }) => sum + documents, 0),
    ).toBe(rows.length);
    expect(counterparties.reduce((sum, { value }) => sum + value, 0)).toBe(
      rows.reduce((sum, { contractValue }) => sum + contractValue, 0),
    );
  });

  test("rebuilding is deterministic", () => {
    expect(build()).toEqual(build());
  });
});
