import { describe, expect, it } from "bun:test";

import {
  rankRecentClients,
  RECENT_CLIENT_SUGGESTIONS_MAX,
} from "@/components/contact-picker.logic";
import { toSafeId } from "@/lib/safe-id";
import type { Workspace } from "@/lib/workspaces/types";

type ClientMatter = Pick<Workspace, "client" | "lastActivityAt">;

const contactId = (id: string) => toSafeId<"contact">(id);

const matter = (
  clientId: string | null,
  lastActivityAt: string,
): ClientMatter => ({
  client:
    clientId === null
      ? null
      : {
          id: contactId(clientId),
          displayName: `Client ${clientId}`,
          type: "organization",
          responsibleAttorneyName: null,
        },
  lastActivityAt,
});

describe("recent client suggestions", () => {
  it("orders clients by their latest matter activity and counts their matters", () => {
    const ranked = rankRecentClients([
      matter("a", "2026-10-01T09:00:00.000Z"),
      matter("b", "2026-10-20T09:00:00.000Z"),
      matter("a", "2026-10-25T09:00:00.000Z"),
      matter("c", "2026-09-01T09:00:00.000Z"),
      matter("a", "2026-08-01T09:00:00.000Z"),
    ]);

    expect(ranked.map(({ id, matterCount }) => [id, matterCount])).toEqual([
      [contactId("a"), 3],
      [contactId("b"), 1],
      [contactId("c"), 1],
    ]);
  });

  it("compares instants rather than timestamp text", () => {
    // Lexically "+02:00" at 10:00 sorts after "Z" at 09:00, but it is the
    // earlier instant (08:00Z).
    const offsetText = "2026-10-01T10:00:00.000+02:00";
    const utcText = "2026-10-01T09:00:00.000Z";
    expect(offsetText > utcText).toBe(true);

    const ranked = rankRecentClients([
      matter("offset", offsetText),
      matter("utc", utcText),
    ]);

    expect(ranked.map(({ id }) => id)).toEqual([
      contactId("utc"),
      contactId("offset"),
    ]);
  });

  it("skips personal matters", () => {
    const ranked = rankRecentClients([
      matter(null, "2026-10-26T09:00:00.000Z"),
      matter("a", "2026-10-01T09:00:00.000Z"),
      matter(null, "2026-10-25T09:00:00.000Z"),
    ]);

    expect(ranked).toEqual([
      {
        id: contactId("a"),
        displayName: "Client a",
        type: "organization",
        matterCount: 1,
      },
    ]);
    expect(
      rankRecentClients([matter(null, "2026-10-26T09:00:00.000Z")]),
    ).toEqual([]);
  });

  it("breaks activity ties by matter count, then by client id", () => {
    const tie = "2026-10-10T09:00:00.000Z";
    const ranked = rankRecentClients([
      matter("d", tie),
      matter("b", tie),
      matter("c", tie),
      matter("c", "2026-01-01T09:00:00.000Z"),
    ]);

    expect(ranked.map(({ id }) => id)).toEqual(["c", "b", "d"].map(contactId));
  });

  it("keeps the most recent clients up to the suggestion limit", () => {
    const clientCount = RECENT_CLIENT_SUGGESTIONS_MAX + 3;
    const day = (index: number) => String(index + 1).padStart(2, "0");
    const matters = Array.from({ length: clientCount }, (_, index) =>
      matter(`client-${day(index)}`, `2026-10-${day(index)}T09:00:00.000Z`),
    );

    const ranked = rankRecentClients(matters);

    expect(ranked).toHaveLength(RECENT_CLIENT_SUGGESTIONS_MAX);
    expect(ranked.map(({ id }) => id)).toEqual(
      Array.from({ length: RECENT_CLIENT_SUGGESTIONS_MAX }, (_, rank) =>
        contactId(`client-${day(clientCount - 1 - rank)}`),
      ),
    );
  });
});
