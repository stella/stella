// Passive regression fixture for
// `dialog-footer-owns-actions/dialog-footer-owns-actions`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

import { AlertDialogContent, AlertDialogFooter } from "@stll/ui/alert-dialog";
import { Button } from "@stll/ui/button";
import { DialogContent, DialogFooter } from "@stll/ui/dialog";
import { Field, FieldControl } from "@stll/ui/field";
import { Input } from "@stll/ui/input";
import { SheetClose, SheetContent, SheetFooter } from "@stll/ui/sheet";

const t = (key: string) => key;
const noop = () => undefined;
const items: string[] = [];
const dirty = items.length > 0;

// --- Flagged: hand-rolled action rows inside a dialog subtree ---
export const _a = () => (
  <DialogContent>
    {/* oxlint-disable-next-line dialog-footer-owns-actions/dialog-footer-owns-actions */}
    <div className="flex justify-end gap-2">
      <Button variant="ghost">{t("common.cancel")}</Button>
      <Button type="submit">{t("common.save")}</Button>
    </div>
  </DialogContent>
);
export const _b = () => (
  <AlertDialogContent>
    {/* oxlint-disable-next-line dialog-footer-owns-actions/dialog-footer-owns-actions */}
    <footer className="mt-4 flex gap-2">
      <Button onClick={noop}>{t("common.discard")}</Button>
      <Button onClick={noop} variant="destructive">
        {t("common.delete")}
      </Button>
    </footer>
  </AlertDialogContent>
);
// Flagged: the close wrapper's `render` button still counts as an action.
export const _c = () => (
  <SheetContent>
    {/* oxlint-disable-next-line dialog-footer-owns-actions/dialog-footer-owns-actions */}
    <section className="flex justify-end gap-2">
      <SheetClose render={<Button variant="outline" />} />
      <Button type="submit">{t("common.apply")}</Button>
    </section>
  </SheetContent>
);
// Flagged: a conditional second action is still a second action.
export const _d = () => (
  <DialogContent>
    <div className="p-6">
      {/* oxlint-disable-next-line dialog-footer-owns-actions/dialog-footer-owns-actions */}
      <div className="flex justify-end gap-2">
        {dirty && <Button variant="ghost">{t("common.reset")}</Button>}
        <Button type="submit">{t("common.save")}</Button>
      </div>
    </div>
  </DialogContent>
);

// Flagged: the popup's body is a component of its own, so no popup element
// encloses the row lexically. It is still the dialog's action row.
export const _e = () => (
  <DialogContent>
    <HandRolledRowBody />
  </DialogContent>
);
const HandRolledRowBody = () => (
  <>
    <p>{t("common.description")}</p>
    {/* oxlint-disable-next-line dialog-footer-owns-actions/dialog-footer-owns-actions */}
    <div className="flex justify-end gap-2">
      <Button variant="ghost">{t("common.cancel")}</Button>
      <Button type="submit">{t("common.save")}</Button>
    </div>
  </>
);

// --- Allowed: the footer primitive owns the row ---
export const _ok1 = () => (
  <DialogContent>
    <DialogFooter>
      <Button variant="ghost">{t("common.cancel")}</Button>
      <Button type="submit">{t("common.save")}</Button>
    </DialogFooter>
  </DialogContent>
);
export const _ok2 = () => (
  <AlertDialogContent>
    <AlertDialogFooter>
      <Button variant="ghost">{t("common.cancel")}</Button>
      <Button variant="destructive">{t("common.delete")}</Button>
    </AlertDialogFooter>
  </AlertDialogContent>
);
// Allowed: a wrapper inside the footer, not a second action row.
export const _ok3 = () => (
  <SheetContent>
    <SheetFooter>
      <div className="flex gap-2">
        <Button variant="ghost">{t("common.cancel")}</Button>
        <Button type="submit">{t("common.save")}</Button>
      </div>
    </SheetFooter>
  </SheetContent>
);
// Allowed: a form row owns its own control affordances.
export const _ok4 = () => (
  <DialogContent>
    <Field>
      <FieldControl render={<Input />} />
      <div className="flex gap-2">
        <Button variant="ghost">{t("common.browse")}</Button>
        <Button variant="ghost">{t("common.clear")}</Button>
      </div>
    </Field>
  </DialogContent>
);
// Allowed: a single action needs no footer band.
export const _ok5 = () => (
  <DialogContent>
    <div className="flex justify-end">
      <Button type="submit">{t("common.save")}</Button>
    </div>
  </DialogContent>
);
// Allowed: per-item buttons rendered from a list, not one action row.
export const _ok6 = () => (
  <DialogContent>
    <div className="flex flex-col gap-2">
      {items.map((item) => (
        <Button key={item} variant="ghost">
          {item}
        </Button>
      ))}
    </div>
  </DialogContent>
);
// Allowed: per-item hover actions rendered from a list callback, not the
// dialog's own row.
export const _ok8 = () => (
  <DialogContent>
    <div className="flex flex-col">
      {items.map((item) => (
        <div className="flex items-center justify-between" key={item}>
          <span>{item}</span>
          <div className="flex gap-1">
            <Button size="icon" variant="ghost" />
            <Button size="icon" variant="ghost" />
          </div>
        </div>
      ))}
    </div>
  </DialogContent>
);
// Allowed: a segmented body control in a popup whose footer already owns the
// action row.
export const _ok9 = () => (
  <DialogContent>
    <div className="flex gap-2">
      <Button variant="outline">{t("common.copy")}</Button>
      <Button variant="outline">{t("common.move")}</Button>
    </div>
    <DialogFooter>
      <Button type="submit">{t("common.save")}</Button>
    </DialogFooter>
  </DialogContent>
);
// Allowed: the body component mounts the footer itself.
export const _ok10 = () => (
  <DialogContent>
    <FooterBody />
  </DialogContent>
);
const FooterBody = () => (
  <DialogFooter>
    <Button variant="ghost">{t("common.cancel")}</Button>
    <Button type="submit">{t("common.save")}</Button>
  </DialogFooter>
);
// Allowed: the popup mounts the footer, so the body component's pair is a
// segmented body control.
export const _ok11 = () => (
  <DialogContent>
    <SegmentedBody />
    <DialogFooter>
      <Button type="submit">{t("common.save")}</Button>
    </DialogFooter>
  </DialogContent>
);
const SegmentedBody = () => (
  <div className="flex gap-2">
    <Button variant="outline">{t("common.copy")}</Button>
    <Button variant="outline">{t("common.move")}</Button>
  </div>
);
// Allowed: a view's root container holds content beside its actions, so it is
// body layout and not the dialog's band.
export const _ok12 = () => (
  <DialogContent>
    <RateEntriesBody />
  </DialogContent>
);
const RateEntriesBody = () => (
  <div className="flex flex-col gap-4">
    <h3>{t("billing.rates.rateEntries")}</h3>
    <Button variant="ghost">{t("common.back")}</Button>
    <Button size="sm">{t("common.add")}</Button>
  </div>
);
// Allowed: the popup writes its own body layout, so a card nested inside it
// owns its controls; they are not the dialog's band.
export const _ok13 = () => (
  <DialogContent>
    <div className="flex flex-col gap-4 p-4">
      <CardFormBody />
    </div>
  </DialogContent>
);
const CardFormBody = () => (
  <div className="rounded-md border p-3">
    <Input />
    <div className="flex justify-end gap-2">
      <Button variant="outline">{t("common.cancel")}</Button>
      <Button type="submit">{t("common.save")}</Button>
    </div>
  </div>
);
// Allowed: the same container shape written inline in the popup.
export const _ok14 = () => (
  <DialogContent>
    <div className="flex flex-col gap-4">
      <h3>{t("billing.rates.rateEntries")}</h3>
      <Button variant="ghost">{t("common.back")}</Button>
      <Button size="sm">{t("common.add")}</Button>
    </div>
  </DialogContent>
);
// Allowed: the same row outside any dialog popup.
export const _ok7 = () => (
  <div className="flex justify-end gap-2">
    <Button variant="ghost">{t("common.cancel")}</Button>
    <Button type="submit">{t("common.save")}</Button>
  </div>
);
