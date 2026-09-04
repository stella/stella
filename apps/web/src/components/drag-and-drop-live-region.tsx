import { useRef } from "react";

import {
  announce,
  cleanup,
} from "@atlaskit/pragmatic-drag-and-drop-live-region";
import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { useExternalSyncEffect } from "@/hooks/use-effect";

import {
  type DragAnnouncementDestination,
  type DragAnnouncementPhase,
  type DragAnnouncementSubject,
  getDragAnnouncementMessageKey,
  getDragAnnouncementSubject,
  getDropAnnouncementDestination,
} from "./drag-and-drop-live-region.logic";

export const DragAndDropLiveRegion = () => {
  const t = useTranslations("common.dragAndDrop");
  const lastDestinationRef = useRef<string | null>(null);

  useExternalSyncEffect(() => {
    const formatDestination = ({
      destination,
      phase,
      subject,
    }: AnnounceDestinationOptions) => {
      const values = {
        count: subject.count,
        destinationName: destination.name,
        itemName: subject.name,
      };
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
          messageKey satisfies never;
          return panic(`Unhandled message key: ${String(messageKey)}`);
      }
    };
    const stopMonitoring = registerDragAnnouncements(
      {
        cancelled: ({ count, name }) =>
          t("cancelled", { count, itemName: name }),
        destination: formatDestination,
        pickedUp: ({ count, name }) => t("pickedUp", { count, itemName: name }),
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
  phase: DragAnnouncementPhase;
  subject: DragAnnouncementSubject;
};

type DragAnnouncementFormatter = {
  cancelled: (subject: DragAnnouncementSubject) => string;
  destination: (options: AnnounceDestinationOptions) => string;
  pickedUp: (subject: DragAnnouncementSubject) => string;
};

type DestinationTracker = {
  current: string | null;
};

const registerDragAnnouncements = (
  format: DragAnnouncementFormatter,
  lastDestination: DestinationTracker,
) =>
  monitorForElements({
    canMonitor: ({ source }) =>
      getDragAnnouncementSubject(source.data) !== null,
    onDragStart: ({ source }) => {
      const subject = getDragAnnouncementSubject(source.data);
      if (!subject) {
        return;
      }
      lastDestination.current = null;
      announce(format.pickedUp(subject));
    },
    onDropTargetChange: ({ source, location }) => {
      const subject = getDragAnnouncementSubject(source.data);
      const destination = getDropAnnouncementDestination(
        location.current.dropTargets,
      );
      if (!subject || !destination) {
        lastDestination.current = null;
        return;
      }
      const destinationKey = `${destination.type}:${destination.name}`;
      if (destinationKey === lastDestination.current) {
        return;
      }
      lastDestination.current = destinationKey;
      announce(format.destination({ destination, phase: "moving", subject }));
    },
    onDrop: ({ source, location }) => {
      const subject = getDragAnnouncementSubject(source.data);
      if (!subject) {
        return;
      }
      const destination = getDropAnnouncementDestination(
        location.current.dropTargets,
      );
      lastDestination.current = null;
      if (!destination) {
        announce(format.cancelled(subject));
        return;
      }
      announce(format.destination({ destination, phase: "moved", subject }));
    },
  });
