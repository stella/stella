import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  initialRecipientsText,
  sendInvoiceFormSchema,
  splitRecipients,
} from "./invoice-sends.logic";

const schema = sendInvoiceFormSchema({
  required: "required",
  tooMany: "too many",
  invalid: "invalid",
  messageTooLong: "too long",
});

const messagesOf = (input: v.InferInput<typeof schema>) => {
  const parsed = v.safeParse(schema, input);
  return parsed.success ? [] : parsed.issues.map((issue) => issue.message);
};

describe("invoice send form", () => {
  test("splits addresses on lines, commas and semicolons, once each", () => {
    expect(
      splitRecipients(
        " billing@example.test,\nlegal@example.test; billing@example.test\n\n",
      ),
    ).toEqual(["billing@example.test", "legal@example.test"]);
  });

  test("sends the parsed addresses and the trimmed note", () => {
    expect(
      v.parse(schema, {
        recipients: "billing@example.test legal@example.test",
        message: "  For October.  ",
      }),
    ).toEqual({
      recipients: ["billing@example.test", "legal@example.test"],
      message: "For October.",
    });
  });

  test("refuses no address, an invalid one, and more than ten", () => {
    expect(messagesOf({ recipients: " \n ", message: "" })).toEqual([
      "required",
    ]);
    expect(
      messagesOf({ recipients: "billing@example.test, nope", message: "" }),
    ).toEqual(["invalid"]);
    const eleven = Array.from(
      { length: 11 },
      (_, index) => `person${index}@example.test`,
    ).join(",");
    expect(messagesOf({ recipients: eleven, message: "" })).toEqual([
      "too many",
    ]);
  });

  test("refuses a note longer than the API accepts", () => {
    expect(
      messagesOf({ recipients: "a@example.test", message: "x".repeat(2001) }),
    ).toEqual(["too long"]);
  });

  test("starts from the given addresses, else the client's", () => {
    expect(
      initialRecipientsText(null, ["a@example.test", "b@example.test"]),
    ).toBe("a@example.test\nb@example.test");
    expect(initialRecipientsText(["c@example.test"], ["a@example.test"])).toBe(
      "c@example.test",
    );
  });
});
