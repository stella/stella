import { MemoryPageShell } from "@/routes/_protected.settings/-account.memory.pending";
import { MemoryPanel } from "@/routes/_protected.settings/-components/account/memory/memory-panel";

/** The memory page: its shell (`MemoryPageShell`) with the live panel. */
export function MemoryPage() {
  return (
    <MemoryPageShell>
      <MemoryPanel />
    </MemoryPageShell>
  );
}
