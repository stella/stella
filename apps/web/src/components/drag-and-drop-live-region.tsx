import { useRef } from "react";

import {
  announce,
  cleanup,
} from "@atlaskit/pragmatic-drag-and-drop-live-region";
import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";

import { useExternalSyncEffect } from "@/hooks/use-effect";

import {
  type DragAnnouncementDestination,
  type DragAnnouncementPhase,
  formatDragCancellationAnnouncement,
  formatDragDestinationAnnouncement,
  formatDragPickupAnnouncement,
  getDragAnnouncementName,
  getDropAnnouncementDestination,
} from "./drag-and-drop-live-region.logic";

export const DragAndDropLiveRegion = () => {
  const lastDestinationRef = useRef<string | null>(null);

  useExternalSyncEffect(() => {
    const stopMonitoring = registerDragAnnouncements(
      DRAG_ANNOUNCEMENT_FORMATTER,
      lastDestinationRef,
    );

    return () => {
      stopMonitoring();
      cleanup();
    };
  }, []);

  return null;
};

type AnnounceDestinationOptions = {
  destination: DragAnnouncementDestination;
  itemName: string;
  phase: DragAnnouncementPhase;
};

type DragAnnouncementFormatter = {
  cancelled: (itemName: string) => string;
  destination: (options: AnnounceDestinationOptions) => string;
  pickedUp: (itemName: string) => string;
};

type DestinationTracker = {
  current: string | null;
};

const DRAG_ANNOUNCEMENT_FORMATTER: DragAnnouncementFormatter = {
  cancelled: formatDragCancellationAnnouncement,
  destination: formatDragDestinationAnnouncement,
  pickedUp: formatDragPickupAnnouncement,
};

const registerDragAnnouncements = (
  format: DragAnnouncementFormatter,
  lastDestination: DestinationTracker,
) =>
  monitorForElements({
    canMonitor: ({ source }) => getDragAnnouncementName(source.data) !== null,
    onDragStart: ({ source }) => {
      const itemName = getDragAnnouncementName(source.data);
      if (!itemName) {
        return;
      }
      lastDestination.current = null;
      announce(format.pickedUp(itemName));
    },
    onDropTargetChange: ({ source, location }) => {
      const itemName = getDragAnnouncementName(source.data);
      const destination = getDropAnnouncementDestination(
        location.current.dropTargets,
      );
      if (!itemName || !destination) {
        lastDestination.current = null;
        return;
      }
      const destinationKey = `${destination.type}:${destination.name}`;
      if (destinationKey === lastDestination.current) {
        return;
      }
      lastDestination.current = destinationKey;
      announce(format.destination({ destination, itemName, phase: "moving" }));
    },
    onDrop: ({ source, location }) => {
      const itemName = getDragAnnouncementName(source.data);
      if (!itemName) {
        return;
      }
      const destination = getDropAnnouncementDestination(
        location.current.dropTargets,
      );
      lastDestination.current = null;
      if (!destination) {
        announce(format.cancelled(itemName));
        return;
      }
      announce(format.destination({ destination, itemName, phase: "moved" }));
    },
  });
