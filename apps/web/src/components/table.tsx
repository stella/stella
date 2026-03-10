import { cn } from "@stella/ui/lib/utils";

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div className="relative" data-slot="table-container">
      <table
        className={cn("w-full caption-bottom text-sm", className)}
        data-slot="table"
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      className={cn("[&_tr]:border-b", className)}
      data-slot="table-header"
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      className={cn("[&_tr:last-child]:border-0", className)}
      data-slot="table-body"
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      className={cn(
        "border-t bg-muted font-medium [&>tr]:last:border-b-0",
        className,
      )}
      data-slot="table-footer"
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      className={cn(
        "group/row isolate border-b transition-colors data-[state=selected]:bg-muted",
        className,
      )}
      data-slot="table-row"
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      className={cn(
        "relative z-0 h-8 border-e bg-background px-2 text-start align-middle font-semibold whitespace-nowrap text-foreground transition-colors last:border-e-0 hover:bg-accent [&:has([role=checkbox])]:pe-0 *:[[role=checkbox]]:translate-y-[2px]",
        className,
      )}
      data-slot="table-head"
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      className={cn(
        "group/cell-content relative z-0 h-auto min-h-8 overflow-hidden border-e bg-background p-2 align-middle whitespace-nowrap group-hover/row:bg-[color-mix(in_srgb,var(--color-foreground)_4%,var(--color-background))] group-data-[state=selected]/row:bg-[color-mix(in_srgb,var(--color-info)_10%,var(--color-background))] group-data-[state=selected]/row:group-hover/row:bg-[color-mix(in_srgb,var(--color-info)_15%,var(--color-background))] last:border-e-0",
        className,
      )}
      data-slot="table-cell"
      {...props}
    />
  );
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      data-slot="table-caption"
      {...props}
    />
  );
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
};
