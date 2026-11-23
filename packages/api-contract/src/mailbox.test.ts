import { describe, expect, test } from "bun:test";

import { mailboxMessageDetails } from "./mailbox";

const formatDate = (date: Date) => date.toISOString().slice(0, 10);

describe("a message's row details", () => {
  test("show the sender, the date and the folder, in that order", () => {
    expect(
      mailboxMessageDetails(
        {
          from: "Mgr. Ondřej Kalina <kalina@ak-kalina-vesela.cz>",
          date: "2026-11-17T08:30:00.000Z",
          folder: "Spisy/Stavby Hradec",
        },
        formatDate,
      ),
    ).toEqual([
      "Mgr. Ondřej Kalina <kalina@ak-kalina-vesela.cz>",
      "2026-11-17",
      "Spisy/Stavby Hradec",
    ]);
  });

  test("a date that does not parse is shown as the header states it", () => {
    expect(
      mailboxMessageDetails(
        { from: null, date: "úterý ráno", folder: null },
        formatDate,
      ),
    ).toEqual(["úterý ráno"]);
  });

  test("leave out what the header does not state", () => {
    expect(
      mailboxMessageDetails(
        { from: " ", date: null, folder: null },
        formatDate,
      ),
    ).toEqual([]);
  });
});
