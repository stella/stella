import { Combobox, ComboboxInput } from "@stll/ui/combobox";
import { Command, CommandInput, CommandPanel } from "@stll/ui/command";
import { CONTROL_SIZES } from "@stll/ui/control-size";
import { Input } from "@stll/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { Textarea } from "@stll/ui/textarea";

const EMPTY_CONTROL_ITEMS = Object.freeze([]);

export const ControlSizesPlayground = () => (
  <section
    className="bg-background flex min-w-0 flex-col gap-4 rounded-lg border p-4 shadow-xs/5"
    data-playground-section="control-sizes"
  >
    <div className="flex flex-col gap-1">
      <h2 className="text-sm font-semibold">Control sizes</h2>
      <p className="text-muted-foreground text-sm">
        Text controls share one size contract while keeping component-specific
        spacing.
      </p>
    </div>
    <div className="grid gap-3">
      {CONTROL_SIZES.map((size) => (
        <div className="grid gap-2 rounded-md border p-3" key={size}>
          <code className="text-muted-foreground text-xs">{size}</code>
          <div className="grid items-start gap-2 sm:grid-cols-2">
            <Input placeholder={`Input ${size}`} size={size} />
            <Textarea placeholder={`Textarea ${size}`} size={size} />
            <Select defaultValue="litigation">
              <SelectTrigger size={size}>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="litigation">Litigation</SelectItem>
              </SelectPopup>
            </Select>
            <Combobox items={EMPTY_CONTROL_ITEMS}>
              <ComboboxInput placeholder={`Combobox ${size}`} size={size} />
            </Combobox>
            <Command items={EMPTY_CONTROL_ITEMS} open={false}>
              <CommandPanel className="px-3 sm:col-span-2">
                <CommandInput placeholder={`Command ${size}`} size={size} />
              </CommandPanel>
            </Command>
          </div>
        </div>
      ))}
    </div>
  </section>
);
