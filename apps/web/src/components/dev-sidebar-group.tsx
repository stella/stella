import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DatabaseIcon, Trash2Icon, WrenchIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import {
  MenuCheckboxItem,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "@stella/ui/components/menu";
import { toastManager } from "@stella/ui/components/toast";

import { api } from "@/lib/api";
import { useDevStore } from "@/lib/dev-store";

export const DevSidebarGroup = () => {
  const queryClient = useQueryClient();
  const [seeding, setSeeding] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const dev = useDevStore(
    useShallow((s) => ({
      tanstackDevtools: s.tanstackDevtools,
      setTanstackDevtools: s.setTanstackDevtools,
      rivetDevtools: s.rivetDevtools,
      setRivetDevtools: s.setRivetDevtools,
      sourceInspector: s.sourceInspector,
      setSourceInspector: s.setSourceInspector,
    })),
  );

  const handleSeed = async () => {
    setSeeding(true);
    const { error } = await api.dev.seed.post();
    setSeeding(false);
    if (error) {
      toastManager.add({
        title: "Seed failed",
        type: "error",
      });
      return;
    }
    await queryClient.invalidateQueries();
    toastManager.add({
      title: "Dev data seeded",
      type: "success",
    });
  };

  const handleClean = async () => {
    setCleaning(true);
    const { error } = await api.dev.clean.post();
    setCleaning(false);
    if (error) {
      toastManager.add({
        title: "Clean failed",
        type: "error",
      });
      return;
    }
    await queryClient.invalidateQueries();
    toastManager.add({
      title: "Dev data cleaned",
      type: "success",
    });
  };

  return (
    <MenuSub>
      <MenuSubTrigger>
        <WrenchIcon />
        {"Dev"}
      </MenuSubTrigger>
      <MenuSubPopup>
        <MenuCheckboxItem
          checked={dev.tanstackDevtools}
          onClick={() => dev.setTanstackDevtools(!dev.tanstackDevtools)}
          variant="switch"
        >
          {"TanStack Devtools"}
        </MenuCheckboxItem>
        <MenuCheckboxItem
          checked={dev.rivetDevtools}
          onClick={() => dev.setRivetDevtools(!dev.rivetDevtools)}
          variant="switch"
        >
          {"Rivet Devtools"}
        </MenuCheckboxItem>
        <MenuCheckboxItem
          checked={dev.sourceInspector}
          onClick={() => dev.setSourceInspector(!dev.sourceInspector)}
          variant="switch"
        >
          {"Source Inspector"}
        </MenuCheckboxItem>
        <MenuSeparator />
        <MenuItem disabled={seeding} onClick={handleSeed}>
          <DatabaseIcon />
          {seeding ? "Seeding..." : "Seed data"}
        </MenuItem>
        <MenuItem disabled={cleaning} onClick={handleClean}>
          <Trash2Icon />
          {cleaning ? "Cleaning..." : "Clean data"}
        </MenuItem>
      </MenuSubPopup>
    </MenuSub>
  );
};
