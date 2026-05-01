import { useState } from "react";
import type * as React from "react";

import {
  Accordion,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from "@stll/ui/components/accordion";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPanel,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@stll/ui/components/alert-dialog";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@stll/ui/components/avatar";
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@stll/ui/components/breadcrumb";
import { Button, buttonVariants } from "@stll/ui/components/button";
import { Checkbox } from "@stll/ui/components/checkbox";
import { ColorPicker } from "@stll/ui/components/color-picker";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stll/ui/components/combobox";
import { DatePickerPopover } from "@stll/ui/components/date-picker-popover";
import {
  DestructiveActionConfirmation,
  useDestructiveActionConfirmation,
} from "@stll/ui/components/destructive-action-confirmation";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@stll/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@stll/ui/components/field";
import { Form } from "@stll/ui/components/form";
import {
  Frame,
  FrameDescription,
  FrameFooter,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/components/frame";
import { HexColorPicker } from "@stll/ui/components/hex-color-picker";
import { Input } from "@stll/ui/components/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
} from "@stll/ui/components/input-group";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@stll/ui/components/input-otp";
import { Label } from "@stll/ui/components/label";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "@stll/ui/components/menu";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@stll/ui/components/pagination";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "@stll/ui/components/popover";
import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardTrigger,
} from "@stll/ui/components/preview-card";
import { ScrollArea } from "@stll/ui/components/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { Separator } from "@stll/ui/components/separator";
import {
  Sheet,
  SheetClose,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
  SheetTrigger,
} from "@stll/ui/components/sheet";
import { Skeleton } from "@stll/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/components/table";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@stll/ui/components/tabs";
import { Textarea } from "@stll/ui/components/textarea";
import { toast } from "@stll/ui/components/toast";
import {
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@stll/ui/components/tooltip";
import {
  ArchiveIcon,
  BellIcon,
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  CopyIcon,
  FileTextIcon,
  FilterIcon,
  LinkIcon,
  LoaderIcon,
  MailIcon,
  SearchIcon,
  SettingsIcon,
  ShieldIcon,
  SquarePenIcon,
  Trash2Icon,
  UserIcon,
} from "lucide-react";

import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";

type ComboboxOption = {
  id: string;
  label: string;
  detail: string;
};

const BUTTON_VARIANTS = [
  "default",
  "secondary",
  "outline",
  "ghost",
  "link",
  "destructive",
  "destructive-outline",
] as const;

const BUTTON_SIZES = ["xs", "sm", "default", "lg", "xl"] as const;

const MATTER_OPTIONS = [
  { value: "general", label: "General matter" },
  { value: "litigation", label: "Litigation" },
  { value: "transaction", label: "Transaction" },
  { value: "employment", label: "Employment" },
] as const;

const COMBOBOX_OPTIONS: ComboboxOption[] = [
  { id: "alpha", label: "Alpha Manufacturing", detail: "Client" },
  { id: "bravo", label: "Bravo Holdings", detail: "Counterparty" },
  { id: "charlie", label: "Charlie Novak", detail: "Witness" },
  { id: "delta", label: "Delta Finance", detail: "Lender" },
];

const TABLE_ROWS = [
  {
    matter: "Supply agreement",
    owner: "M. Novak",
    status: "Review",
    due: "Apr 30",
  },
  {
    matter: "Board consent",
    owner: "A. Smith",
    status: "Draft",
    due: "May 03",
  },
  {
    matter: "Lease amendment",
    owner: "K. Lee",
    status: "Filed",
    due: "May 08",
  },
] as const;

export function UiPlayground() {
  const [checkboxChecked, setCheckboxChecked] = useState(true);
  const [selectValue, setSelectValue] = useState("litigation");
  const [comboboxQuery, setComboboxQuery] = useState("");
  const [comboboxValue, setComboboxValue] = useState<ComboboxOption | null>(
    null,
  );
  const [otpValue, setOtpValue] = useState("123");
  const [dateValue, setDateValue] = useState<string | null>("2026-04-27");
  const [colorValue, setColorValue] = useState("blue");
  const [hexColor, setHexColor] = useState("#59A1D4");
  const destructiveConfirmation = useDestructiveActionConfirmation(
    "delete this workspace",
  );

  const filteredComboboxOptions = COMBOBOX_OPTIONS.filter((option) =>
    `${option.label} ${option.detail}`
      .toLowerCase()
      .includes(comboboxQuery.toLowerCase()),
  );

  const showPromiseToast = () => {
    void toast.promise(
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("complete"), 900);
      }),
      {
        loading: { title: "Saving draft" },
        success: { title: "Draft saved" },
        error: { title: "Save failed" },
      },
    );
  };

  const showUpdatingToast = () => {
    const toastId = toast.loading("Uploading bundle", {
      description: "Preparing files",
    });
    setTimeout(() => {
      toast.update(toastId, {
        title: "Upload complete",
        description: "Three files were added to the matter.",
        type: "success",
      });
    }, 900);
  };

  return (
    <main className="bg-background min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-2 border-b pb-6">
          <h1 className="font-heading text-2xl font-semibold tracking-normal">
            Stella UI Playground
          </h1>
          <p className="text-muted-foreground max-w-3xl text-sm">
            Stable primitives from @stll/ui with mock content, core variants,
            and common edge states.
          </p>
        </header>

        <Tabs defaultValue="actions">
          <TabsList className="bg-background/96 sticky top-0 z-20 py-2 backdrop-blur">
            <TabsTab value="actions">Actions</TabsTab>
            <TabsTab value="forms">Forms</TabsTab>
            <TabsTab value="overlays">Overlays</TabsTab>
            <TabsTab value="navigation">Navigation</TabsTab>
            <TabsTab value="feedback">Feedback</TabsTab>
            <TabsTab value="data">Data</TabsTab>
            <TabsTab value="chat">Chat</TabsTab>
          </TabsList>

          <TabsPanel value="actions">
            <PlaygroundGrid>
              <PlaygroundSection
                description="Variants, sizes, icon-only buttons, loading, and disabled states."
                title="Button"
              >
                <div className="flex flex-wrap items-center gap-2">
                  {BUTTON_VARIANTS.map((variant) => (
                    <Button key={variant} variant={variant}>
                      {variant}
                    </Button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {BUTTON_SIZES.map((size) => (
                    <Button key={size} size={size} variant="outline">
                      {size}
                    </Button>
                  ))}
                  <Button loading>Saving</Button>
                  <Button disabled variant="outline">
                    Disabled
                  </Button>
                  <Button aria-label="Settings" size="icon" variant="ghost">
                    <SettingsIcon />
                  </Button>
                </div>
              </PlaygroundSection>

              <PlaygroundSection
                description="Menu items, shortcuts, checkbox items, radio items, and nested submenus."
                title="Menu"
              >
                <Menu>
                  <MenuTrigger render={<Button variant="outline" />}>
                    Actions
                    <ChevronDownIcon />
                  </MenuTrigger>
                  <MenuPopup align="start" className="w-56">
                    <MenuItem>
                      <FileTextIcon />
                      Open matter
                      <MenuShortcut>O</MenuShortcut>
                    </MenuItem>
                    <MenuItem>
                      <CopyIcon />
                      Copy link
                      <MenuShortcut>C</MenuShortcut>
                    </MenuItem>
                    <MenuSeparator />
                    <MenuCheckboxItem checked variant="switch">
                      Notify followers
                    </MenuCheckboxItem>
                    <MenuGroup>
                      <MenuGroupLabel>Sort</MenuGroupLabel>
                      <MenuRadioGroup value="recent">
                        <MenuRadioItem value="recent">Recent</MenuRadioItem>
                        <MenuRadioItem value="name">Name</MenuRadioItem>
                      </MenuRadioGroup>
                    </MenuGroup>
                    <MenuSeparator />
                    <MenuSub>
                      <MenuSubTrigger>
                        <ArchiveIcon />
                        Archive
                      </MenuSubTrigger>
                      <MenuSubPopup>
                        <MenuItem>Archive selected</MenuItem>
                        <MenuItem>Archive all closed</MenuItem>
                      </MenuSubPopup>
                    </MenuSub>
                    <MenuItem variant="destructive">
                      <Trash2Icon />
                      Delete
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              </PlaygroundSection>

              <PlaygroundSection
                description="Tooltip, preview card, and popover triggers."
                title="Inline Overlays"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Tooltip>
                    <TooltipTrigger
                      render={<Button size="icon" variant="outline" />}
                    >
                      <BellIcon />
                    </TooltipTrigger>
                    <TooltipPopup>Notifications</TooltipPopup>
                  </Tooltip>

                  <PreviewCard>
                    <PreviewCardTrigger render={<Button variant="outline" />}>
                      Preview contact
                    </PreviewCardTrigger>
                    <PreviewCardPopup>
                      <div className="flex gap-3">
                        <Avatar>
                          <AvatarFallback>AN</AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <div className="font-medium">Anna Novak</div>
                          <div className="text-muted-foreground text-sm">
                            External counsel, Prague
                          </div>
                        </div>
                      </div>
                    </PreviewCardPopup>
                  </PreviewCard>

                  <Popover>
                    <PopoverTrigger render={<Button variant="outline" />}>
                      Filter
                      <FilterIcon />
                    </PopoverTrigger>
                    <PopoverPopup className="w-72">
                      <div className="flex flex-col gap-3">
                        <PopoverTitle>Filters</PopoverTitle>
                        <PopoverDescription>
                          Limit the list by status and owner.
                        </PopoverDescription>
                        <Separator />
                        <Label>Owner</Label>
                        <Input defaultValue="M. Novak" />
                        <Button size="sm">Apply</Button>
                      </div>
                    </PopoverPopup>
                  </Popover>
                </div>
              </PlaygroundSection>
            </PlaygroundGrid>
          </TabsPanel>

          <TabsPanel value="forms">
            <PlaygroundGrid>
              <PlaygroundSection
                description="Inputs, textareas, labels, descriptions, invalid states, and grouped adornments."
                title="Fields"
              >
                <Form
                  onSubmit={(event) => {
                    event.preventDefault();
                    toast.success("Form submitted");
                  }}
                >
                  <Field>
                    <FieldLabel>Matter name</FieldLabel>
                    <Input defaultValue="Supply agreement review" />
                    <FieldDescription>
                      Visible labels and helper text stay close to the control.
                    </FieldDescription>
                  </Field>

                  <Field>
                    <FieldLabel>Reference</FieldLabel>
                    <Input aria-invalid defaultValue="12345678901234567890" />
                    <FieldError match>Reference is too long.</FieldError>
                  </Field>

                  <Field>
                    <FieldLabel>Notes</FieldLabel>
                    <Textarea defaultValue="Counterparty requested a narrow confidentiality carve-out." />
                  </Field>

                  <InputGroup>
                    <InputGroupAddon>
                      <SearchIcon />
                    </InputGroupAddon>
                    <InputGroupInput placeholder="Search matters" />
                    <InputGroupAddon align="inline-end">
                      <InputGroupText>⌘K</InputGroupText>
                    </InputGroupAddon>
                  </InputGroup>

                  <InputGroup>
                    <InputGroupAddon align="block-start">
                      <InputGroupText>Internal summary</InputGroupText>
                    </InputGroupAddon>
                    <InputGroupTextarea defaultValue="Longer text keeps the same frame and focus treatment." />
                  </InputGroup>

                  <Button className="w-fit" type="submit">
                    Submit
                  </Button>
                </Form>
              </PlaygroundSection>

              <PlaygroundSection
                description="Checkbox, select, combobox, OTP, date, and color controls."
                title="Inputs"
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="flex items-center gap-2 text-sm">
                    <Checkbox
                      id="playground-checkbox-checked"
                      checked={checkboxChecked}
                      onCheckedChange={setCheckboxChecked}
                    />
                    <Label htmlFor="playground-checkbox-checked">
                      Checked checkbox
                    </Label>
                  </div>

                  <div className="flex items-center gap-2 text-sm">
                    <Checkbox id="playground-checkbox-mixed" indeterminate />
                    <Label htmlFor="playground-checkbox-mixed">
                      Indeterminate checkbox
                    </Label>
                  </div>
                </div>

                <Select
                  onValueChange={(value) => {
                    if (value) {
                      setSelectValue(value);
                    }
                  }}
                  value={selectValue}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select matter type" />
                  </SelectTrigger>
                  <SelectPopup>
                    {MATTER_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>

                <Combobox<ComboboxOption>
                  itemToStringLabel={(option) => option.label}
                  onInputValueChange={setComboboxQuery}
                  onValueChange={setComboboxValue}
                  value={comboboxValue}
                >
                  <ComboboxInput
                    placeholder="Search contacts"
                    showClear={comboboxQuery.length > 0}
                    startAddon={<SearchIcon />}
                    value={comboboxQuery}
                  />
                  <ComboboxPopup>
                    <ComboboxList>
                      {filteredComboboxOptions.map((option) => (
                        <ComboboxItem key={option.id} value={option}>
                          <div className="flex min-w-0 flex-col">
                            <span>{option.label}</span>
                            <span className="text-muted-foreground text-xs">
                              {option.detail}
                            </span>
                          </div>
                        </ComboboxItem>
                      ))}
                    </ComboboxList>
                    {filteredComboboxOptions.length === 0 ? (
                      <ComboboxEmpty>No results</ComboboxEmpty>
                    ) : null}
                  </ComboboxPopup>
                </Combobox>

                <InputOTP maxLength={6} onChange={setOtpValue} value={otpValue}>
                  <InputOTPGroup>
                    <InputOTPSlot index={0} />
                    <InputOTPSlot index={1} />
                    <InputOTPSlot index={2} />
                  </InputOTPGroup>
                  <InputOTPSeparator />
                  <InputOTPGroup>
                    <InputOTPSlot index={3} />
                    <InputOTPSlot index={4} />
                    <InputOTPSlot index={5} />
                  </InputOTPGroup>
                </InputOTP>

                <div className="flex flex-wrap items-center gap-2">
                  <DatePickerPopover
                    onChange={setDateValue}
                    value={dateValue}
                  />
                  <ColorPicker
                    onClear={() => setColorValue("")}
                    onSelect={setColorValue}
                    value={colorValue}
                  >
                    <Button variant="outline">
                      Color
                      <span
                        className="size-4 rounded border"
                        style={{
                          backgroundColor: `var(--option-${colorValue})`,
                        }}
                      />
                    </Button>
                  </ColorPicker>
                </div>

                <div className="flex flex-col gap-2">
                  <Label>Hex color picker</Label>
                  <HexColorPicker
                    className="!h-36 !w-full max-w-sm overflow-hidden rounded-lg border"
                    color={hexColor}
                    onChange={setHexColor}
                  />
                </div>
              </PlaygroundSection>
            </PlaygroundGrid>
          </TabsPanel>

          <TabsPanel value="overlays">
            <PlaygroundGrid>
              <PlaygroundSection
                description="Dialog and alert dialog layouts with header, panel, footer, and close actions."
                title="Dialogs"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Dialog>
                    <DialogTrigger render={<Button variant="outline" />}>
                      Open dialog
                    </DialogTrigger>
                    <DialogPopup>
                      <DialogHeader>
                        <DialogTitle>Share matter</DialogTitle>
                        <DialogDescription>
                          Invite a collaborator and choose their access level.
                        </DialogDescription>
                      </DialogHeader>
                      <DialogPanel className="space-y-4">
                        <Field>
                          <FieldLabel>Email</FieldLabel>
                          <Input defaultValue="anna@example.com" />
                        </Field>
                        <Field>
                          <FieldLabel>Message</FieldLabel>
                          <Textarea defaultValue="Please review the latest draft." />
                        </Field>
                      </DialogPanel>
                      <DialogFooter>
                        <DialogClose render={<Button variant="ghost" />}>
                          Cancel
                        </DialogClose>
                        <DialogClose render={<Button />}>Send</DialogClose>
                      </DialogFooter>
                    </DialogPopup>
                  </Dialog>

                  <AlertDialog>
                    <AlertDialogTrigger
                      render={
                        <span
                          className={buttonVariants({
                            variant: "destructive-outline",
                          })}
                        />
                      }
                    >
                      Open alert
                    </AlertDialogTrigger>
                    <AlertDialogPopup>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete draft?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This removes the draft from the current matter.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogClose render={<Button variant="ghost" />}>
                          Cancel
                        </AlertDialogClose>
                        <AlertDialogClose
                          render={<Button variant="destructive" />}
                        >
                          Delete
                        </AlertDialogClose>
                      </AlertDialogFooter>
                    </AlertDialogPopup>
                  </AlertDialog>

                  <AlertDialog
                    onOpenChange={(open) => {
                      if (!open) {
                        destructiveConfirmation.reset();
                      }
                    }}
                  >
                    <AlertDialogTrigger
                      render={
                        <span
                          className={buttonVariants({
                            variant: "destructive-outline",
                          })}
                        />
                      }
                    >
                      Typed confirmation
                    </AlertDialogTrigger>
                    <AlertDialogPopup>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete workspace?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This permanently removes the workspace, files,
                          metadata, and audit context from the app.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogPanel>
                        <DestructiveActionConfirmation
                          confirmation="delete this workspace"
                          description="This must match exactly before the action is enabled."
                          label="Type the confirmation phrase"
                          onValueChange={destructiveConfirmation.onValueChange}
                          placeholder="delete this workspace"
                          value={destructiveConfirmation.value}
                        />
                      </AlertDialogPanel>
                      <AlertDialogFooter>
                        <AlertDialogClose render={<Button variant="ghost" />}>
                          Cancel
                        </AlertDialogClose>
                        <AlertDialogClose
                          render={
                            <Button
                              disabled={!destructiveConfirmation.confirmed}
                              variant="destructive"
                            />
                          }
                        >
                          Delete workspace
                        </AlertDialogClose>
                      </AlertDialogFooter>
                    </AlertDialogPopup>
                  </AlertDialog>
                </div>
              </PlaygroundSection>

              <PlaygroundSection
                description="Sheet sides, inset treatment, scrolling panel, and footer actions."
                title="Sheet"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Sheet>
                    <SheetTrigger render={<Button variant="outline" />}>
                      Right sheet
                    </SheetTrigger>
                    <SheetPopup side="right" variant="inset">
                      <SheetHeader>
                        <SheetTitle>Matter details</SheetTitle>
                        <SheetDescription>
                          Inspect metadata without leaving the current page.
                        </SheetDescription>
                      </SheetHeader>
                      <SheetPanel className="space-y-4">
                        {TABLE_ROWS.map((row) => (
                          <div
                            className="flex items-center justify-between gap-4 border-b pb-3 text-sm last:border-b-0"
                            key={row.matter}
                          >
                            <span>{row.matter}</span>
                            <span className="text-muted-foreground">
                              {row.status}
                            </span>
                          </div>
                        ))}
                      </SheetPanel>
                      <SheetFooter>
                        <SheetClose render={<Button variant="ghost" />}>
                          Close
                        </SheetClose>
                        <Button>Save</Button>
                      </SheetFooter>
                    </SheetPopup>
                  </Sheet>

                  <Sheet>
                    <SheetTrigger render={<Button variant="outline" />}>
                      Bottom sheet
                    </SheetTrigger>
                    <SheetPopup side="bottom">
                      <SheetHeader>
                        <SheetTitle>Batch actions</SheetTitle>
                        <SheetDescription>
                          Apply one action to selected rows.
                        </SheetDescription>
                      </SheetHeader>
                      <SheetFooter>
                        <SheetClose render={<Button variant="ghost" />}>
                          Cancel
                        </SheetClose>
                        <Button>Apply</Button>
                      </SheetFooter>
                    </SheetPopup>
                  </Sheet>
                </div>
              </PlaygroundSection>

              <PlaygroundSection
                description="Accordion open, closed, disabled, and long content states."
                title="Accordion"
              >
                <Accordion defaultValue={["scope"]} multiple>
                  <AccordionItem value="scope">
                    <AccordionTrigger>Scope</AccordionTrigger>
                    <AccordionPanel>
                      The component supports long explanatory content with a
                      smooth height transition and clear focus styling.
                    </AccordionPanel>
                  </AccordionItem>
                  <AccordionItem value="security">
                    <AccordionTrigger>Security</AccordionTrigger>
                    <AccordionPanel>
                      Access controls, audit trails, and workspace isolation are
                      handled outside this primitive.
                    </AccordionPanel>
                  </AccordionItem>
                  <AccordionItem disabled value="disabled">
                    <AccordionTrigger>Disabled item</AccordionTrigger>
                    <AccordionPanel>Unavailable content.</AccordionPanel>
                  </AccordionItem>
                </Accordion>
              </PlaygroundSection>
            </PlaygroundGrid>
          </TabsPanel>

          <TabsPanel value="navigation">
            <PlaygroundGrid>
              <PlaygroundSection
                description="Breadcrumb links, ellipsis, page state, and separator."
                title="Breadcrumb"
              >
                <Breadcrumb>
                  <BreadcrumbList>
                    <BreadcrumbItem>
                      <BreadcrumbLink href="/workspaces">
                        Matters
                      </BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      <BreadcrumbEllipsis />
                    </BreadcrumbItem>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      <BreadcrumbLink href="/workspaces/example">
                        Supply agreement
                      </BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      <BreadcrumbPage>Draft review</BreadcrumbPage>
                    </BreadcrumbItem>
                  </BreadcrumbList>
                </Breadcrumb>
              </PlaygroundSection>

              <PlaygroundSection
                description="Pagination links, active page, previous, next, and ellipsis."
                title="Pagination"
              >
                <Pagination>
                  <PaginationContent>
                    <PaginationItem>
                      <PaginationPrevious href="#previous" />
                    </PaginationItem>
                    <PaginationItem>
                      <PaginationLink href="#1">1</PaginationLink>
                    </PaginationItem>
                    <PaginationItem>
                      <PaginationLink href="#2" isActive>
                        2
                      </PaginationLink>
                    </PaginationItem>
                    <PaginationItem>
                      <PaginationEllipsis />
                    </PaginationItem>
                    <PaginationItem>
                      <PaginationNext href="#next" />
                    </PaginationItem>
                  </PaginationContent>
                </Pagination>
              </PlaygroundSection>

              <PlaygroundSection
                description="Default and underline tabs, including a compact local example."
                title="Tabs"
              >
                <Tabs defaultValue="summary">
                  <TabsList>
                    <TabsTab value="summary">Summary</TabsTab>
                    <TabsTab value="files">Files</TabsTab>
                    <TabsTab disabled value="billing">
                      Billing
                    </TabsTab>
                  </TabsList>
                  <TabsPanel
                    className="rounded-lg border p-4 text-sm"
                    value="summary"
                  >
                    Summary panel
                  </TabsPanel>
                  <TabsPanel
                    className="rounded-lg border p-4 text-sm"
                    value="files"
                  >
                    Files panel
                  </TabsPanel>
                  <TabsPanel value="billing">Billing panel</TabsPanel>
                </Tabs>

                <Tabs defaultValue="first">
                  <TabsList variant="underline">
                    <TabsTab value="first">First</TabsTab>
                    <TabsTab value="second">Second</TabsTab>
                  </TabsList>
                </Tabs>
              </PlaygroundSection>
            </PlaygroundGrid>
          </TabsPanel>

          <TabsPanel value="feedback">
            <PlaygroundGrid>
              <PlaygroundSection
                description="Toast variants, promise handling, loading update, actions, persistence, and long text."
                title="Toast"
              >
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() => {
                      void toast.success("Saved");
                    }}
                  >
                    Success
                  </Button>
                  <Button
                    onClick={() => {
                      void toast.error("Unable to save", {
                        description: "The server rejected the update.",
                      });
                    }}
                    variant="destructive-outline"
                  >
                    Error
                  </Button>
                  <Button
                    onClick={() => {
                      void toast.warning("Missing approver", {
                        action: {
                          label: "Assign",
                          onClick: () => {
                            void toast.info("Assignee picker opened");
                          },
                        },
                      });
                    }}
                    variant="outline"
                  >
                    Action
                  </Button>
                  <Button onClick={showUpdatingToast} variant="outline">
                    Loading update
                  </Button>
                  <Button onClick={showPromiseToast} variant="outline">
                    Promise
                  </Button>
                  <Button
                    onClick={() => {
                      void toast.info(
                        "This is a deliberately long notification title that should wrap cleanly inside the toast viewport",
                        {
                          description:
                            "Descriptions should wrap without pushing the close button out of the toast.",
                        },
                      );
                    }}
                    variant="outline"
                  >
                    Long text
                  </Button>
                </div>
              </PlaygroundSection>

              <PlaygroundSection
                description="Skeleton blocks and scroll fade treatment."
                title="Loading"
              >
                <div className="space-y-3">
                  <Skeleton className="h-5 w-2/3" />
                  <Skeleton className="h-20 w-full rounded-lg" />
                  <div className="h-40 rounded-lg border">
                    <ScrollArea scrollFade scrollbarGutter>
                      <div className="space-y-3 p-4">
                        {Array.from({ length: 12 }, (_, index) => (
                          <div className="flex items-center gap-3" key={index}>
                            <Skeleton className="size-8 rounded-full" />
                            <div className="flex-1 space-y-2">
                              <Skeleton className="h-3 w-1/2" />
                              <Skeleton className="h-3 w-3/4" />
                            </div>
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  </div>
                </div>
              </PlaygroundSection>

              <PlaygroundSection
                description="Avatars with image, fallback, sizes, and grouped text."
                title="Avatar"
              >
                <div className="flex items-center gap-4">
                  <Avatar className="size-10">
                    <AvatarImage
                      alt="Anna Novak"
                      src="https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=128&q=80"
                    />
                    <AvatarFallback>AN</AvatarFallback>
                  </Avatar>
                  <Avatar>
                    <AvatarFallback>MS</AvatarFallback>
                  </Avatar>
                  <Avatar className="size-6 text-[0.625rem]">
                    <AvatarFallback>KL</AvatarFallback>
                  </Avatar>
                </div>
              </PlaygroundSection>
            </PlaygroundGrid>
          </TabsPanel>

          <TabsPanel value="data">
            <PlaygroundGrid>
              <PlaygroundSection
                description="Frame container, panel header, panel body, and footer slots."
                title="Frame"
              >
                <Frame>
                  <FrameHeader>
                    <FrameTitle>Workspace health</FrameTitle>
                    <FrameDescription>
                      Shared frame treatment for dense operational surfaces.
                    </FrameDescription>
                  </FrameHeader>
                  <FramePanel>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <Metric icon={<ShieldIcon />} label="Access" value="24" />
                      <Metric icon={<ClockIcon />} label="Due" value="7" />
                      <Metric icon={<MailIcon />} label="Unread" value="12" />
                    </div>
                  </FramePanel>
                  <FrameFooter>
                    <Button size="sm" variant="outline">
                      View audit log
                    </Button>
                  </FrameFooter>
                </Frame>
              </PlaygroundSection>

              <PlaygroundSection
                description="Table header, body, selected row, footer, caption, and overflow behavior."
                title="Table"
              >
                <Frame>
                  <FramePanel className="p-0">
                    <Table>
                      <TableCaption>Mock matters</TableCaption>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Matter</TableHead>
                          <TableHead>Owner</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Due</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {TABLE_ROWS.map((row, index) => (
                          <TableRow
                            data-state={index === 1 ? "selected" : undefined}
                            key={row.matter}
                          >
                            <TableCell>{row.matter}</TableCell>
                            <TableCell>{row.owner}</TableCell>
                            <TableCell>{row.status}</TableCell>
                            <TableCell>{row.due}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                      <TableFooter>
                        <TableRow>
                          <TableCell colSpan={3}>Total</TableCell>
                          <TableCell>3</TableCell>
                        </TableRow>
                      </TableFooter>
                    </Table>
                  </FramePanel>
                </Frame>
              </PlaygroundSection>

              <PlaygroundSection
                description="Separators, icon/text rows, and dense list content."
                title="Separator"
              >
                <div className="flex flex-col gap-3 text-sm">
                  <div className="flex items-center gap-2">
                    <UserIcon className="text-muted-foreground size-4" />
                    Owner changed to M. Novak
                  </div>
                  <Separator />
                  <div className="flex items-center gap-2">
                    <LinkIcon className="text-muted-foreground size-4" />
                    Link copied to clipboard
                  </div>
                  <Separator />
                  <div className="flex h-10 items-center gap-3">
                    <span>Left</span>
                    <Separator orientation="vertical" />
                    <span>Right</span>
                  </div>
                </div>
              </PlaygroundSection>
            </PlaygroundGrid>
          </TabsPanel>

          <TabsPanel value="chat">
            <PlaygroundGrid>
              <PlaygroundSection
                description="Existing assistant + user bubble types from the standalone chat panel. We need to lift each into the unified file-anchored chat (Phase C)."
                title="Chat bubbles"
              >
                <ChatBubbleSink />
              </PlaygroundSection>
              <PlaygroundSection
                description="One row per bubble type that exists today and isn't in the unified chat yet."
                title="Inventory"
              >
                <ChatBubbleInventory />
              </PlaygroundSection>
            </PlaygroundGrid>
          </TabsPanel>
        </Tabs>
      </div>
    </main>
  );
}

function PlaygroundGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-5 py-5 lg:grid-cols-2">{children}</div>;
}

function PlaygroundSection({
  children,
  description,
  title,
}: {
  children: React.ReactNode;
  description: string;
  title: string;
}) {
  return (
    <section className="bg-background flex min-w-0 flex-col gap-4 rounded-lg border p-4 shadow-xs/5">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
    </section>
  );
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border p-3">
      <div className="text-muted-foreground [&_svg]:size-4">{icon}</div>
      <div className="min-w-0">
        <div className="text-lg leading-none font-semibold">{value}</div>
        <div className="text-muted-foreground mt-1 text-xs">{label}</div>
      </div>
    </div>
  );
}

/**
 * Mock chat bubbles — rendered with hand-built JSX so we don't have
 * to construct AI-SDK `ChatMessage` fixtures that match the strict
 * tool schemas. These reproduce the visual surface of every bubble
 * type so we can review them in one place; the actual production
 * renderer (ChatThreadMessages) still drives real chat.
 */
function ChatBubbleSink() {
  return (
    <div className="bg-popover/40 flex max-h-[70dvh] flex-col gap-6 overflow-y-auto rounded-2xl border p-4">
      <Message from="user">
        <MessageContent>
          <span className="whitespace-pre-wrap">
            Summarise the SPA in matter Acme/EnerGo and flag the indemnity
            exposure.
          </span>
        </MessageContent>
      </Message>

      <Message from="assistant">
        <MessageContent>
          <MessageResponse>
            {[
              "**Summary.** The SPA is a share purchase between Acme Holdings and EnerGo Distribuce, dated 1 Feb 2025.",
              "",
              "Key terms:",
              "- Purchase price: EUR 50,000,000 with EUR 5,000,000 escrow.",
              "- Closing conditional on antitrust clearance.",
              "- Caps and baskets are aggressive vs. our standard playbook (5% / 0.1%).",
              "",
              "I'd rate the indemnity exposure **medium** — the carve-outs for tax and environmental are wider than typical.",
            ].join("\n")}
          </MessageResponse>
        </MessageContent>
      </Message>

      <Message from="user">
        <MessageContent>
          <span className="whitespace-pre-wrap">
            Compare the indemnity clause against my version of the playbook.
          </span>
          <button
            type="button"
            className="text-muted-foreground bg-muted/60 hover:bg-muted inline-flex w-fit items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
          >
            <FileTextIcon className="size-3" />
            indemnity-playbook.pdf
          </button>
        </MessageContent>
      </Message>

      <Message from="assistant">
        <MessageContent>
          <MessageResponse>
            {`Cross-checked against your playbook. The SPA's indemnity in §8.2 sets a survival period of 24 months — your standard is 36.`}
          </MessageResponse>
          <button
            type="button"
            className="text-info hover:bg-info/10 inline-flex w-fit items-center gap-1 rounded-md px-1.5 py-0.5 text-xs no-underline"
          >
            <FileTextIcon className="size-3" />
            EnerGo SPA Final.docx
          </button>
        </MessageContent>
      </Message>

      <ApprovalCardMock
        title="Create document"
        description="EnerGo SPA Final — redline §8.2.docx"
        path="Drafts/"
      />

      <UpdateFieldsCardMock />

      <AskUserCardMock />

      <ToolCallMock />

      <Message from="assistant">
        <MessageContent>
          <MessageResponse>
            {`Czech labour code §52 lists six redundancy grounds — restructuring is one. The relevant case is **30 Cdo 161/2024**.`}
          </MessageResponse>
          <div className="flex flex-wrap gap-1.5 pt-1">
            <SourceChipMock label="30 Cdo 161/2024" kind="case-law" />
            <SourceChipMock
              label="EnerGo SPA Final.docx · §8.2"
              kind="entity"
            />
          </div>
        </MessageContent>
      </Message>

      <Message from="assistant">
        <MessageContent>
          <span className="text-muted-foreground inline-flex items-center gap-2 text-xs">
            <LoaderIcon
              className="text-muted-foreground/70 size-3 animate-spin"
              aria-hidden="true"
            />
            Thinking…
          </span>
        </MessageContent>
      </Message>
    </div>
  );
}

function ApprovalCardMock(props: {
  title: string;
  description: string;
  path: string;
}) {
  return (
    <Message from="assistant">
      <MessageContent className="max-w-[460px]">
        <MessageResponse>
          {`I can draft a redline reverting §8.2 to a 36-month survival. Approve to create.`}
        </MessageResponse>
        <div className="flex flex-col gap-2.5 rounded-lg border p-3">
          <div className="flex items-center gap-2">
            <SquarePenIcon
              className="text-muted-foreground size-4"
              aria-hidden="true"
            />
            <div className="flex flex-col">
              <span className="text-sm font-medium">{props.title}</span>
              <span className="text-muted-foreground text-xs">
                {props.path}
                {props.description}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="xs">Approve</Button>
            <Button size="xs" variant="outline">
              Deny
            </Button>
            <Button size="xs" variant="ghost" className="ms-auto">
              Always allow
            </Button>
          </div>
        </div>
      </MessageContent>
    </Message>
  );
}

function UpdateFieldsCardMock() {
  return (
    <Message from="assistant">
      <MessageContent className="max-w-[460px]">
        <MessageResponse>
          {`I extracted the closing date and parties. Update the matter record?`}
        </MessageResponse>
        <div className="flex flex-col gap-2.5 rounded-lg border p-3">
          <div className="flex items-center gap-2">
            <SettingsIcon
              className="text-muted-foreground size-4"
              aria-hidden="true"
            />
            <span className="text-sm font-medium">Update entity fields</span>
          </div>
          <ul className="text-muted-foreground flex flex-col gap-1 text-xs">
            <li>
              <span className="font-medium">Closing</span>: 2025-04-30
            </li>
            <li>
              <span className="font-medium">Parties</span>: Acme Holdings;
              EnerGo Distribuce
            </li>
          </ul>
          <div className="flex items-center gap-1.5">
            <Button size="xs">Approve</Button>
            <Button size="xs" variant="outline">
              Deny
            </Button>
          </div>
        </div>
      </MessageContent>
    </Message>
  );
}

function AskUserCardMock() {
  return (
    <Message from="assistant">
      <MessageContent className="max-w-[460px]">
        <MessageResponse>
          {`Two of the schedules reference different governing-law clauses. Which one should I treat as canonical?`}
        </MessageResponse>
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <span className="text-muted-foreground text-xs">
            Schedule 4 says English law; Schedule 7 says Czech law with English
            seat. Which governs?
          </span>
          <div className="flex flex-col gap-1.5">
            <Button size="xs" variant="outline">
              English law (Schedule 4)
            </Button>
            <Button size="xs" variant="outline">
              Czech law, English seat (Schedule 7)
            </Button>
            <Button size="xs" variant="outline">
              Other / I'll explain in chat
            </Button>
          </div>
        </div>
      </MessageContent>
    </Message>
  );
}

function ToolCallMock() {
  return (
    <Message from="assistant">
      <MessageContent className="max-w-[460px]">
        <MessageResponse>
          {`Pulled the redlines from version history.`}
        </MessageResponse>
        <div className="bg-muted/40 flex flex-col gap-1.5 rounded-md border p-2 text-xs">
          <div className="flex items-center gap-1.5">
            <CheckIcon className="text-success size-3" aria-hidden="true" />
            <span className="text-muted-foreground">search-entities</span>
          </div>
          <ul className="text-muted-foreground ms-4 list-disc">
            <li>SPA v3 (final).docx</li>
            <li>SPA v2 (Smith comments).docx</li>
          </ul>
        </div>
      </MessageContent>
    </Message>
  );
}

function SourceChipMock(props: { label: string; kind: "case-law" | "entity" }) {
  return (
    <button
      type="button"
      className="text-info bg-info/10 hover:bg-info/15 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs"
    >
      <span className="bg-info inline-block size-1.5 rounded-full" />
      <span className="text-muted-foreground text-[10px] uppercase">
        {props.kind === "case-law" ? "case" : "doc"}
      </span>
      <span className="text-foreground">{props.label}</span>
    </button>
  );
}

function ChatBubbleInventory() {
  const rows: { name: string; status: string }[] = [
    { name: "User text", status: "✓ unified" },
    { name: "User file attachment", status: "✗ not in unified" },
    { name: "Assistant text + markdown", status: "✓ unified (Streamdown)" },
    {
      name: "Assistant with entity-mention links",
      status: "✗ not in unified",
    },
    {
      name: "Tool-approval card (create-document)",
      status: "✗ not in unified",
    },
    {
      name: "Tool-approval card (update-entity-fields)",
      status: "✗ not in unified",
    },
    { name: "Ask-user card", status: "✗ not in unified" },
    {
      name: "Tool-call result card (non-approval)",
      status: "✗ not in unified",
    },
    {
      name: "Source chips (case-law + entity)",
      status: "partial — own model",
    },
    { name: "Thinking indicator", status: "partial — simpler spinner" },
    { name: "Edit-suggestion review queue", status: "✓ unified only" },
    {
      name: "In-document citations (folio + pdf)",
      status: "✓ unified only",
    },
  ];
  return (
    <ul className="text-sm">
      {rows.map((row) => (
        <li
          key={row.name}
          className="border-border/50 flex items-center justify-between gap-2 border-b py-2 last:border-b-0"
        >
          <span>{row.name}</span>
          <span className="text-muted-foreground text-xs">{row.status}</span>
        </li>
      ))}
    </ul>
  );
}
