import { useEffect, useState } from "react";

import { storage } from "../../lib/storage";
import type { RecentClip } from "../../types";

const formatTime = (isoString: string): string => {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);

  if (diffMin < 1) {
    return "Just now";
  }
  if (diffMin < 60) {
    return `${String(diffMin)}m ago`;
  }

  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) {
    return `${String(diffHrs)}h ago`;
  }

  const diffDays = Math.floor(diffHrs / 24);
  return `${String(diffDays)}d ago`;
};

export const RecentClips = () => {
  const [clips, setClips] = useState<RecentClip[]>([]);

  useEffect(() => {
    void storage.getRecentClips().then(setClips);

    // Re-fetch when storage changes (e.g. after a save).
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === "local" && "stella:recentClips" in changes) {
        const change = changes["stella:recentClips"];
        if (change !== undefined && Array.isArray(change.newValue)) {
          // SAFETY: chrome.storage returns untyped; we control writes.
          // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
          setClips(change.newValue as RecentClip[]);
        }
      }
    };

    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  if (clips.length === 0) {
    return (
      <section className="mb-5">
        <h2 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
          Recent clips
        </h2>
        <p className="text-muted-foreground py-6 text-center text-[13px]">
          No clips saved yet.
        </p>
      </section>
    );
  }

  return (
    <section className="mb-5">
      <h2 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
        Recent clips
      </h2>
      {clips.map((clip) => (
        <div
          key={clip.id}
          className="border-border bg-card mb-2 rounded-lg border p-3"
        >
          <div className="text-foreground truncate text-sm font-medium">
            {clip.title}
          </div>
          <div className="text-muted-foreground truncate text-xs">
            {clip.url}
          </div>
          <div className="mt-1.5 flex items-center justify-between">
            <span className="bg-accent text-accent-foreground inline-block rounded px-2 py-0.5 text-[11px] font-medium">
              {clip.matterName}
            </span>
            <span className="text-muted-foreground text-[11px]">
              {formatTime(clip.savedAt)}
            </span>
          </div>
        </div>
      ))}
    </section>
  );
};
