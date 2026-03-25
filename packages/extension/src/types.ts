/** Data sent to the Stella API when saving a clip. */
export type ClipData = {
  title: string;
  url: string;
  snippet?: string;
  citation?: string;
  jurisdiction?: string;
  sourceType?: string;
};

/** Metadata extracted from a web page by the content script. */
export type PageMetadata = {
  url: string;
  title: string;
  /** Text selected by the user, if any. */
  selection?: string;
  /** Favicon URL from the tab. */
  favIconUrl?: string;
};

/** A matter (workspace) in Stella. */
export type Matter = {
  id: string;
  name: string;
  reference: string;
};

/** A recently saved clip, stored in chrome.storage.local. */
export type RecentClip = {
  id: string;
  title: string;
  url: string;
  matterId: string;
  matterName: string;
  savedAt: string;
};

/** A queued clip waiting for network connectivity. */
export type QueuedClip = {
  id: string;
  matterId: string;
  data: ClipData;
  queuedAt: string;
};
