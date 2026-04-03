import { useCallback, useEffect, useState } from "react";

import { stellaApi } from "../../lib/api";
import { storage } from "../../lib/storage";
import type { Matter } from "../../types";

type MatterPickerProps = {
  onMatterChange: (matter: Matter | null) => void;
};

export const MatterPicker = ({ onMatterChange }: MatterPickerProps) => {
  const [matters, setMatters] = useState<Matter[]>([]);
  const [activeMatterId, setActiveMatterId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // Call API directly from side panel; bearer
      // token is attached automatically by api.ts.
      const result = await stellaApi.getMatters();

      if (result.ok) {
        setMatters(result.data);

        // Restore persisted active matter.
        const saved = await storage.getActiveMatter();
        if (saved) {
          const match = result.data.find((m) => m.id === saved.id);
          if (match) {
            setActiveMatterId(match.id);
            onMatterChange(match);
          }
        }
      } else {
        setError(result.error);
      }
    } finally {
      setLoading(false);
    }
  }, [onMatterChange]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const matterId = e.target.value;
    if (!matterId) {
      setActiveMatterId(null);
      onMatterChange(null);
      return;
    }

    const matter = matters.find((m) => m.id === matterId);
    if (!matter) {
      return;
    }

    setActiveMatterId(matterId);
    onMatterChange(matter);
    // eslint-disable-next-line no-console
    void storage.setActiveMatter(matter).catch(console.error);
  };

  if (loading) {
    return (
      <section className="mb-5">
        <h2 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
          Matter
        </h2>
        <p className="text-muted-foreground py-6 text-center text-[13px]">
          Loading matters...
        </p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="mb-5">
        <h2 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
          Matter
        </h2>
        <p className="text-destructive text-[13px]">
          Failed to load matters: {error}
        </p>
      </section>
    );
  }

  return (
    <section className="mb-5">
      <h2 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
        Matter
      </h2>
      <select
        className="border-input bg-card text-foreground w-full cursor-pointer rounded-lg border px-3 py-2 text-sm outline-none"
        value={activeMatterId ?? ""}
        onChange={handleChange}
      >
        <option value="">Select a matter...</option>
        {matters.map((matter) => (
          <option key={matter.id} value={matter.id}>
            {matter.reference} — {matter.name}
          </option>
        ))}
      </select>
    </section>
  );
};
