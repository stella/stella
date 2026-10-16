type LinkIcon = {
  bytes: Uint8Array;
  mime: "image/png" | "image/x-icon";
};

export type LinkIconOutcome =
  | { type: "icon"; icon: LinkIcon }
  | { type: "no-icon" }
  | { type: "temporary" };

export type CacheableLinkIconOutcome = Exclude<
  LinkIconOutcome,
  { type: "temporary" }
>;
