import { describe, expect, test } from "bun:test";

import { normalizeActiveDocxEditToolInput } from "@/api/handlers/chat/tools/active-docx-edit-tool-repair";

const parseJson = (text: string | null): unknown =>
  text === null ? null : JSON.parse(text);

describe("normalizeActiveDocxEditToolInput", () => {
  test("keeps valid blockId operations unchanged", () => {
    expect(
      parseJson(
        normalizeActiveDocxEditToolInput(
          JSON.stringify({
            operations: [
              {
                blockId: "b-0010",
                find: "David Cuketa",
                replace: "Jiří Novotný",
                type: "replaceInBlock",
              },
            ],
          }),
        ),
      ),
    ).toEqual({
      operations: [
        {
          blockId: "b-0010",
          find: "David Cuketa",
          replace: "Jiří Novotný",
          type: "replaceInBlock",
        },
      ],
    });
  });

  test("preserves the batch contract version through repair", () => {
    expect(
      parseJson(
        normalizeActiveDocxEditToolInput(
          JSON.stringify({
            version: 1,
            operations: [
              {
                blockId: "b-0010",
                find: "old",
                kind: "replaceInBlock",
                replace: "new",
              },
            ],
          }),
        ),
      ),
    ).toEqual({
      version: 1,
      operations: [
        {
          blockId: "b-0010",
          find: "old",
          replace: "new",
          type: "replaceInBlock",
        },
      ],
    });
  });

  test("repairs the kind alias for the operation type", () => {
    expect(
      parseJson(
        normalizeActiveDocxEditToolInput(
          JSON.stringify({
            operations: [
              {
                blockId: "b-0010",
                find: "David Cuketa",
                kind: "replaceInBlock",
                replace: "Jiří Novotný",
              },
            ],
          }),
        ),
      ),
    ).toEqual({
      operations: [
        {
          blockId: "b-0010",
          find: "David Cuketa",
          replace: "Jiří Novotný",
          type: "replaceInBlock",
        },
      ],
    });
  });

  test("keeps id as the contract operation id (no blockId alias repair)", () => {
    // Under the versioned contract `id` is the operation id, so the
    // repair layer must NOT rewrite it into `blockId`; the operation
    // stays as-is and fails validation on the missing blockId instead.
    expect(
      parseJson(
        normalizeActiveDocxEditToolInput(
          JSON.stringify({
            operations: [
              {
                find: "David Cuketa",
                id: "op-1",
                kind: "replaceInBlock",
                replace: "Jiří Novotný",
              },
            ],
          }),
        ),
      ),
    ).toEqual({
      operations: [
        {
          find: "David Cuketa",
          id: "op-1",
          replace: "Jiří Novotný",
          type: "replaceInBlock",
        },
      ],
    });
  });

  test("repairs JSON-stringified operations inside the operations array", () => {
    expect(
      parseJson(
        normalizeActiveDocxEditToolInput(
          JSON.stringify({
            operations: [
              JSON.stringify({
                blockId: "b-0010",
                find: "David Cuketa",
                replace: "Jiří Novotný",
                type: "replaceInBlock",
              }),
            ],
          }),
        ),
      ),
    ).toEqual({
      operations: [
        {
          blockId: "b-0010",
          find: "David Cuketa",
          replace: "Jiří Novotný",
          type: "replaceInBlock",
        },
      ],
    });
  });

  test("infers replaceInBlock when find and replace are present", () => {
    expect(
      parseJson(
        normalizeActiveDocxEditToolInput(
          JSON.stringify({
            operations: [
              {
                blockId: "b-0010",
                find: "David Cuketa",
                replace: "Pavel Novotný",
              },
            ],
          }),
        ),
      ),
    ).toEqual({
      operations: [
        {
          blockId: "b-0010",
          find: "David Cuketa",
          replace: "Pavel Novotný",
          type: "replaceInBlock",
        },
      ],
    });
  });

  test("leaves non-object operation strings unrepaired", () => {
    expect(
      normalizeActiveDocxEditToolInput(
        JSON.stringify({
          operations: [
            'replaceInBlock(b-0010, "David Cuketa", "Jiří Novotný")',
          ],
        }),
      ),
    ).toBeNull();
  });
});
