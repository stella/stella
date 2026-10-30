/**
 * Every icon Stella draws, from one module (`@stll/ui/icons`).
 *
 * This is the only file allowed to import from `lucide-react`
 * (`no-direct-lucide-import` enforces it), so what a glyph means is decided
 * here once instead of at each call site.
 *
 * Adding an icon:
 * 1. Reuse first. If an entry below already names what you are drawing, use it.
 * 2. When the icon stands for a product concept (a skill, an AI action, a
 *    section of the app), add a semantic entry: a name for the concept, the
 *    lucide glyph behind it, and a one-line comment saying why that glyph. Two
 *    semantic entries may share a glyph only with a `sharedOnPurpose:` line
 *    naming the other entry and the reason (`icons.test.ts` checks this). A
 *    glyph that only one component may draw (because the component carries
 *    behaviour, such as `CopyButton` confirming in place) adds an
 *    `ownedBy: <Component> (<repo path>)` line; `no-unowned-icon` then
 *    rejects every import of the entry outside that file. A glyph with a
 *    semantic entry is never re-exported under its plain lucide name, so a
 *    call site has to pick the meaning it draws.
 * 3. Otherwise the icon is a plain re-export under its lucide name. Import it
 *    from here and run `bun scripts/codemod-icons.ts`, which rewrites any
 *    direct `lucide-react` import and regenerates the list at the bottom.
 *
 * Only ESM named re-exports live here, and the package marks nothing but its
 * CSS as having side effects, so a bundler keeps just the glyphs a page uses.
 */

// --- Semantic entries ------------------------------------------------------

// A skill or saved prompt is saved instructions, so it reads as a book; the
// wand is reserved for AI actions.
export { BookOpenIcon as SkillIcon } from "lucide-react";
// An action the AI performs on the user's text or data (improve prompt,
// rewrite, refine a search, AI rename, summarize, auto-run).
export { WandSparklesIcon as AiActionIcon } from "lucide-react";
// The case-law section: its sidebar entry, landing page and research tool.
// sharedOnPurpose: SkillIcon, the law section's book predates the skill icon; giving it its own glyph is a separate product call.
export { BookOpenIcon as CaseLawIcon } from "lucide-react";
// Starting a new AI chat: a chat bubble with a plus, the same glyph on every
// new-chat button, menu item and rail action.
export { MessageSquarePlusIcon as NewChatIcon } from "lucide-react";
// Commenting on a document passage: a quoted bubble, so it never reads as
// starting a new AI chat.
export { MessageSquareQuoteIcon as AddCommentIcon } from "lucide-react";

// Copying to the clipboard from a button. The button confirms in place (the
// glyph turns into a check), so the glyph is drawn only by that button.
// ownedBy: CopyButton (packages/ui/src/components/copy-button.tsx)
export { CopyIcon as CopyToClipboardIcon } from "lucide-react";
// A copy action inside a menu or popover that closes on click, so the copy is
// confirmed with a toast instead of in place.
// sharedOnPurpose: CopyToClipboardIcon, the same action where an in-place check cannot be seen.
export { CopyIcon as CopyFromMenuIcon } from "lucide-react";
// Duplicating an item (a row, page, view, position): it makes a second item,
// not a clipboard copy.
// sharedOnPurpose: CopyToClipboardIcon, lucide's two-sheet glyph is the common duplicate mark.
// sharedOnPurpose: CopyFromMenuIcon, as above.
export { CopyIcon as DuplicateIcon } from "lucide-react";

// --- Plain re-exports ------------------------------------------------------
// @generated-start by scripts/codemod-icons.ts: edit by importing a lucide name and rerunning it
export type { LucideIcon } from "lucide-react";
export {
  ActivityIcon,
  AlarmClockIcon,
  AlertCircleIcon,
  AlertTriangleIcon,
  AlignJustifyIcon,
  AlignLeftIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  AtSignIcon,
  BanIcon,
  BanknoteIcon,
  BellIcon,
  BlocksIcon,
  BoldIcon,
  BookOpenCheckIcon,
  BookTextIcon,
  BookmarkIcon,
  BookmarkPlusIcon,
  BracesIcon,
  BrainIcon,
  Building2Icon,
  BuildingIcon,
  CableIcon,
  CalendarClockIcon,
  CalendarIcon,
  CheckCheckIcon,
  CheckCircle2Icon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ChevronsUpDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleHelpIcon,
  CircleIcon,
  CircleOffIcon,
  CircleUserRoundIcon,
  ClipboardCheckIcon,
  ClipboardCopyIcon,
  ClipboardIcon,
  ClipboardListIcon,
  Clock3Icon,
  ClockIcon,
  CogIcon,
  Columns2Icon,
  Columns3Icon,
  ColumnsIcon,
  CommandIcon,
  CompassIcon,
  CopyPlusIcon,
  CornerDownLeftIcon,
  CpuIcon,
  CropIcon,
  DatabaseIcon,
  DollarSignIcon,
  DownloadIcon,
  EditIcon,
  EllipsisIcon,
  EllipsisVerticalIcon,
  EqualIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  FileBadgeIcon,
  FileCheckIcon,
  FileCodeIcon,
  FileDiffIcon,
  FileDigitIcon,
  FileDownIcon,
  FileIcon,
  FileImageIcon,
  FileOutputIcon,
  FilePenLineIcon,
  FilePlus2Icon,
  FilePlusIcon,
  FileQuestionIcon,
  FileSearchIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileUpIcon,
  FilterIcon,
  FilterXIcon,
  FlagIcon,
  FlaskConicalIcon,
  FoldHorizontalIcon,
  FolderIcon,
  FolderInputIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  FolderSyncIcon,
  FolderTreeIcon,
  FunctionSquareIcon,
  GanttChartIcon,
  GaugeIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GitPullRequestIcon,
  GlobeIcon,
  GraduationCapIcon,
  GripVerticalIcon,
  HashIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  HelpCircleIcon,
  HighlighterIcon,
  HistoryIcon,
  ImageIcon,
  ImageOffIcon,
  InboxIcon,
  InfoIcon,
  ItalicIcon,
  KanbanIcon,
  KeyRoundIcon,
  KeyboardIcon,
  LandmarkIcon,
  LanguagesIcon,
  LaptopIcon,
  LayersIcon,
  LayoutDashboardIcon,
  LayoutGridIcon,
  LayoutTemplateIcon,
  LibraryBigIcon,
  LibraryIcon,
  Link2Icon,
  LinkIcon,
  ListChecksIcon,
  ListFilterIcon,
  ListIcon,
  ListMinusIcon,
  ListOrderedIcon,
  ListTodoIcon,
  ListTreeIcon,
  ListXIcon,
  LoaderCircleIcon,
  LockIcon,
  LockKeyholeIcon,
  LockOpenIcon,
  LogOutIcon,
  MailIcon,
  Maximize2Icon,
  MegaphoneIcon,
  MessageCircleQuestionIcon,
  MessageSquareIcon,
  MessageSquareTextIcon,
  MessageSquareWarningIcon,
  MessagesSquareIcon,
  Minimize2Icon,
  MinusIcon,
  MonitorIcon,
  MoonIcon,
  MoreHorizontalIcon,
  PackageIcon,
  PaletteIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PaperclipIcon,
  PauseIcon,
  PenIcon,
  PenLineIcon,
  PencilIcon,
  PencilLineIcon,
  PhoneIcon,
  PinIcon,
  PinOffIcon,
  PlayIcon,
  PlugIcon,
  PlusIcon,
  PowerIcon,
  PrinterIcon,
  QuoteIcon,
  Redo2Icon,
  RefreshCcwIcon,
  RefreshCwIcon,
  RepeatIcon,
  RotateCcwIcon,
  RotateCwIcon,
  RouteIcon,
  Rows2Icon,
  Rows3Icon,
  SaveIcon,
  ScanSearchIcon,
  ScanTextIcon,
  ScissorsIcon,
  ScrollTextIcon,
  SearchIcon,
  SearchXIcon,
  SendIcon,
  ServerIcon,
  Settings2Icon,
  ShapesIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldIcon,
  SigmaIcon,
  SignatureIcon,
  SlashIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  SplitIcon,
  SquareCheckIcon,
  SquareIcon,
  SquareMinusIcon,
  SquarePenIcon,
  StarIcon,
  StarOffIcon,
  StickyNoteIcon,
  StrikethroughIcon,
  SunIcon,
  TableIcon,
  TagIcon,
  TagsIcon,
  TerminalIcon,
  TextIcon,
  TextQuoteIcon,
  ToggleLeftIcon,
  Trash2Icon,
  TrashIcon,
  TriangleAlertIcon,
  UnderlineIcon,
  Undo2Icon,
  UndoIcon,
  UnfoldHorizontalIcon,
  UngroupIcon,
  UploadIcon,
  UserCheckIcon,
  UserIcon,
  UserPlusIcon,
  UserRoundIcon,
  UsersIcon,
  VideoIcon,
  WavesIcon,
  WindIcon,
  WorkflowIcon,
  WrapTextIcon,
  WrenchIcon,
  XCircleIcon,
  XIcon,
  XSquareIcon,
  ZapIcon,
} from "lucide-react";
// @generated-end
