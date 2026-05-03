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

  test("repairs common model aliases for block id and operation type", () => {
    expect(
      parseJson(
        normalizeActiveDocxEditToolInput(
          JSON.stringify({
            operations: [
              {
                find: "David Cuketa",
                id: "b-0010",
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

  test("repairs JSON-stringified operations inside the operations array", () => {
    expect(
      parseJson(
        normalizeActiveDocxEditToolInput(
          JSON.stringify({
            operations: [
              JSON.stringify({
                find: "David Cuketa",
                id: "b-0010",
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
