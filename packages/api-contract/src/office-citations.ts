export const OFFICE_CITATION_HREF_PREFIX = "#office:";

export type OfficeCitationHrefTarget = {
  blockId: string;
  entityId: string;
  fieldId: string;
};

export type OfficeCitationLocator =
  | {
      type: "pptx";
      slideIndex: number;
    }
  | {
      type: "xlsx";
      range: string;
      sheetIndex: number;
      sheetName: string;
    };

const OFFICE_CITATION_BLOCK_ID_RE = /^(?:pptx|xlsx)-[0-9a-f]{16}$/u;
const OFFICE_CITATION_HREF_RE =
  /^#office:(?<entityId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(?<fieldId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(?<blockId>[^:]+)$/u;

export const isOfficeCitationBlockId = (value: string): boolean =>
  OFFICE_CITATION_BLOCK_ID_RE.test(value);

export const parseOfficeCitationHref = (
  href: string,
): OfficeCitationHrefTarget | null => {
  const match = OFFICE_CITATION_HREF_RE.exec(href);
  const entityId = match?.groups?.["entityId"];
  const fieldId = match?.groups?.["fieldId"];
  const blockId = match?.groups?.["blockId"];
  return entityId && fieldId && blockId && isOfficeCitationBlockId(blockId)
    ? { blockId, entityId, fieldId }
    : null;
};
