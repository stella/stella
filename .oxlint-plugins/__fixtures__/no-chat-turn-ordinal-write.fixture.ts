import { chatThreads, chatTurns } from "@/api/db/schema";

type Write = { values: (row: unknown) => unknown; set: (row: unknown) => unknown };
declare const tx: {
  insert: (table: unknown) => Write;
  update: (table: unknown) => Write;
};
declare const turn: { id: string; threadId: string };

// A turn's position supplied by the code that stores it.
const _inserted = tx.insert(chatTurns).values({
  ...turn,
  // oxlint-disable-next-line no-chat-turn-ordinal-write/no-chat-turn-ordinal-write
  ordinal: 3,
});
const _insertedMany = tx.insert(chatTurns).values([
  turn,
  // oxlint-disable-next-line no-chat-turn-ordinal-write/no-chat-turn-ordinal-write
  { ...turn, ordinal: 4 },
]);
// oxlint-disable-next-line no-chat-turn-ordinal-write/no-chat-turn-ordinal-write
const _moved = tx.update(chatTurns).set({ ordinal: 5 });
// oxlint-disable-next-line no-chat-turn-ordinal-write/no-chat-turn-ordinal-write
const _counted = tx.update(chatThreads).set({ lastTurnOrdinal: 5 });

// Writes that leave both columns to the database are fine.
// expect-clean: no-chat-turn-ordinal-write/no-chat-turn-ordinal-write
const _stored = tx.insert(chatTurns).values({ ...turn });
// expect-clean: no-chat-turn-ordinal-write/no-chat-turn-ordinal-write
const _titled = tx.update(chatThreads).set({ title: "Renamed" });

export const __noChatTurnOrdinalWriteFixture = {
  _inserted,
  _insertedMany,
  _moved,
  _counted,
  _stored,
  _titled,
};
