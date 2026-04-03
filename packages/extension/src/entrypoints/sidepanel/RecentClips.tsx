import { useEffect, useState } from "react";

import type { RecentClip } from "../../types";
import { storage } from "../../lib/storage";

const formatTime = (isoString: string): string => {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);

  if (diffMin < 1) {return "Just now";}
  if (diffMin < 60) {return `${String(diffMin)}m ago`;}

  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) {return `${String(diffHrs)}h ago`;}

  const diffDays = Math.floor(diffHrs / 24);
  return `${String(diffDays)}d ago`;
};

export const RecentClips = () => {
  const [clips, setClips] = useState<RecentClip[]>([]);

  useEffect(() => {
    storage.getRecentClips().then(setClips);

    // Re-fetch when storage changes (e.g. after a save).
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (
        area === "local" &&
        "stella:recentClips" in changes
      ) {
        const newValue =
          changes["stella:recentClips"]?.newValue;
        if (Array.isArray(newValue)) {
          // SAFETY: chrome.storage returns untyped; we control writes.
          // eslint-disable-next-line typescript/consistent-type-assertions
          setClips(newValue as RecentClip[]);
        }
      }
    };

    chrome.storage.onChanged.addListener(listener);
    return () =>
      chrome.storage.onChanged.removeListener(listener);
  }, []);

  if (clips.length === 0) {
    return (
      <section className="mb-5">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Recent clips
        </h2>
        <p className="py-6 text-center text-[13px] text-muted-foreground">
          No clips saved yet.
        </p>
      </section>
    );
  }

  return (
    <section className="mb-5">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Recent clips
      </h2>
      {clips.map((clip) => (
        <div
          key={clip.id}
          className="mb-2 rounded-lg border border-border bg-card p-3"
        >
          <div className="truncate text-sm font-medium text-foreground">
            {clip.title}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {clip.url}
          </div>
          <div className="mt-1.5 flex items-center justify-between">
            <span className="inline-block rounded bg-accent px-2 py-0.5 text-[11px] font-medium text-accent-foreground">
              {clip.matterName}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {formatTime(clip.savedAt)}
            </span>
          </div>
        </div>
      ))}
    </section>
  );
};
