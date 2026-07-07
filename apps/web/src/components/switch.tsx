"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "@stll/ui/lib/utils";

// Local Switch wrapper over the Base UI primitive. The shared @stll/ui package
// does not ship a switch yet; this lives in apps/web so the playbook editor's
// per-position enable toggle stays on a real switch control (not a checkbox).
// Promote to @stll/ui when a second consumer appears.
function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "focus-visible:ring-ring focus-visible:ring-offset-background data-checked:bg-primary data-unchecked:bg-input relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-offset-1 data-disabled:opacity-64",
        className,
      )}
      data-slot="switch"
      {...props}
    >
      <SwitchPrimitive.Thumb
        className="bg-background pointer-events-none block size-4 rounded-full shadow-xs transition-transform data-checked:translate-x-4.5 data-unchecked:translate-x-0.5"
        data-slot="switch-thumb"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
