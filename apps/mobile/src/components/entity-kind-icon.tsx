import {
  FileIcon,
  FileTextIcon,
  FolderIcon,
  LinkIcon,
  ListTodoIcon,
  MailIcon,
} from "@/icons.gen";

/** A matter item's glyph, the web's for its kind (apps/web entity-kind-icon.tsx). */
export const EntityKindIcon = ({
  color,
  kind,
  size = 18,
}: {
  color: string;
  kind: string;
  size?: number;
}) => {
  switch (kind) {
    case "folder":
      return <FolderIcon color={color} size={size} />;
    case "task":
      return <ListTodoIcon color={color} size={size} />;
    case "message":
      return <MailIcon color={color} size={size} />;
    case "link":
      return <LinkIcon color={color} size={size} />;
    case "document":
      return <FileTextIcon color={color} size={size} />;
    default:
      return <FileIcon color={color} size={size} />;
  }
};
