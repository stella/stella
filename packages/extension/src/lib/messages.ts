import type { ClipData, Matter, PageMetadata } from "../types";

// -- Content script -> Service worker messages --

export type PageMetadataMessage = {
  action: "page-metadata";
  payload: PageMetadata;
};

// -- Side panel -> Service worker messages --

export type SaveClipMessage = {
  action: "save-clip";
  payload: {
    matterId: string;
    data: ClipData;
  };
};

export type GetMattersMessage = {
  action: "get-matters";
};

export type SetActiveMatterMessage = {
  action: "set-active-matter";
  payload: { matter: Matter };
};

export type GetActiveMatterMessage = {
  action: "get-active-matter";
};

export type GetPageMetadataMessage = {
  action: "get-page-metadata";
};

export type CaptureSelectionMessage = {
  action: "capture-selection";
};

// -- Web app -> Extension messages (external) --

export type ExternalSetMatterMessage = {
  action: "set-matter";
  payload: { matter: Matter };
};

// -- Union types --

export type InternalMessage =
  | PageMetadataMessage
  | SaveClipMessage
  | GetMattersMessage
  | SetActiveMatterMessage
  | GetActiveMatterMessage
  | GetPageMetadataMessage
  | CaptureSelectionMessage;

export type ExternalMessage = ExternalSetMatterMessage;

// -- Responses --

export type SaveClipResponse =
  | { success: true; entityId: string }
  | { success: false; error: string; queued?: boolean };

export type GetMattersResponse =
  | { success: true; matters: Matter[] }
  | { success: false; error: string };

export type GetActiveMatterResponse = {
  matter: Matter | null;
};
