import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";

// Inline citations the way models write them: the court named just before a
// decision link ("Shodně NS …", "Ústavní soud v nálezu …"), a decision with no
// court named before it, and provisions wrapped in parentheses. The decisions
// are seeded ones, so every chip resolves on a seeded stack.
export const CHAT_CITATION_CHIPS_CASSETTE = [
  {
    createdAt: new Date("2026-11-18T10:02:00.000Z"),
    edited: false,
    id: "01a18a40-2c00-7a00-8a00-000000000001",
    role: "user",
    revision: 0,
    parts: [
      {
        type: "text",
        content: "Jak soudy posuzují opakované prodlení s nájemným?",
      },
    ],
  },
  {
    createdAt: new Date("2026-11-18T10:02:24.000Z"),
    edited: false,
    id: "01a18a40-2c00-7a00-8a00-000000000002",
    metadata: { turnTiming: { status: "finished", durationMs: 24_000 } },
    parts: [
      {
        type: "text",
        content: [
          // oxlint-disable-next-line no-raw-resource-uri/no-raw-resource-uri -- an answer as a model writes it; the decision links are what this fixture renders
          "Příklad z NS [22 Cdo 102/2018](#stella-decision=a1220b81-31c2-53c8-8eb1-3c0b61bf7658): opakované prodlení je hrubým porušením povinnosti (§ 2291 odst. 2 OZ). Shodně NS [25 Cdo 118/2020](#stella-decision=d3bd2841-f316-5931-8811-d9d337b6d522).",
          "",
          // oxlint-disable-next-line no-raw-resource-uri/no-raw-resource-uri -- an answer as a model writes it; the decision link is what this fixture renders
          "Ústavní soud v nálezu [IV.ÚS 1394/24](#stella-decision=0a80f0eb-79fb-55d0-8e0f-b36e528d388c) zdůraznil přiměřenost výpovědi. Podle rozsudku [26 Cdo 119/2020](#stella-decision=3ef07c18-a458-5f3b-86bf-283f489385f4) rozhoduje celkový obraz platební kázně.",
          "",
          "Výpověď musí mít písemnou formu ([§ 2286 odst. 1 OZ](/law/cze/statutes/89-2012-sb-obcansky-zakonik#par_2286)) a pronajímatel ji odůvodní ( [§ 2288 odst. 1 písm. a) OZ](/law/cze/statutes/89-2012-sb-obcansky-zakonik#par_2288) ).",
        ].join("\n"),
      },
    ],
    revision: 0,
    role: "assistant",
  },
] satisfies readonly PersistedChatMessage[];
