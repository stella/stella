import { expect, test } from "bun:test";

import { UI_LOCALES } from "@stll/locales";
import { rejectionOf } from "@stll/property-testing/rejection";

import { getAuth } from "@/api/lib/auth";

test("the account preference accepts document language and every shipped UI language", async () => {
  const before = getAuth().options.databaseHooks.user.update.before;
  for (const readerAnswerLanguage of ["document", ...UI_LOCALES]) {
    const result = await before({ readerAnswerLanguage }, null);
    expect(result.data["readerAnswerLanguage"]).toBe(readerAnswerLanguage);
  }
});

test.each(["", "xx", "en<script>", 42, { locale: "en" }])(
  "the account preference rejects malformed or unshipped language %j",
  async (readerAnswerLanguage) => {
    const before = getAuth().options.databaseHooks.user.update.before;
    expect(
      await rejectionOf(before({ readerAnswerLanguage }, null)),
    ).toMatchObject({
      status: "BAD_REQUEST",
      body: { message: "Invalid reader answer language" },
    });
  },
);
