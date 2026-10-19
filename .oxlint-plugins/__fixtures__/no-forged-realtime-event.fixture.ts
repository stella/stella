// oxlint-disable-next-line no-forged-realtime-event/no-forged-realtime-event -- Positive fixture for forbidden brand creation outside owners.
const brand = "BuiltRealtimeEvent";
// oxlint-disable-next-line no-forged-realtime-event/no-forged-realtime-event -- Positive fixture for forbidden deletion event construction.
const event = {
  type: "resource.deleted",
  resource: { type: "entity", id: "fixture" },
};
// expect-clean: no-forged-realtime-event/no-forged-realtime-event
const unrelated = { status: "deleted" };
export const realtimeOwnerFixture = [brand, event, unrelated];
