import { useRef } from "react";

import {
  announce,
  cleanup,
} from "@atlaskit/pragmatic-drag-and-drop-live-region";
import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";
import { useTranslations } from "use-intl";

import { useExternalSyncEffect } from "@/hooks/use-effect";

import {
  type DragAnnouncementDestination,
  type DragAnnouncementPhase,
  getDragAnnouncementName,
  getDragAnnouncementMessageKey,
  getDropAnnouncementDestination,
} from "./drag-and-drop-live-region.logic";

export const DragAndDropLiveRegion = () => {
  const t = useTranslations("common.dragAndDrop");
  const lastDestinationRef = useRef<string | null>(null);

  useExternalSyncEffect(() => {
    const formatDestination = ({
      destination,
      itemName,
      phase,
    }: AnnounceDestinationOptions) => {
      const values = { destinationName: destination.name, itemName };
      const messageKey = getDragAnnouncementMessageKey(phase, destination.type);
      switch (messageKey) {
        case "movingTo":
          return t("movingTo", values);
        case "movingNear":
          return t("movingNear", values);
        case "droppedOn":
          return t("droppedOn", values);
        case "movedTo":
          return t("movedTo", values);
        case "movedNear":
          return t("movedNear", values);
        default:
          return messageKey satisfies never;
      }
    };
    const stopMonitoring = registerDragAnnouncements(
      {
        cancelled: (itemName) => t("cancelled", { itemName }),
        destination: formatDestination,
        pickedUp: (itemName) => t("pickedUp", { itemName }),
      },
      lastDestinationRef,
    );

    return () => {
      stopMonitoring();
      cleanup();
    };
  }, [t]);

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
