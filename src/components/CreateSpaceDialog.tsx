import { Button } from "@base-ui/react/button";
import { Dialog } from "@base-ui/react/dialog";
import { Check, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  COLOR_KEYS,
  type Space,
  type SpaceColorKey,
  type SpaceIconKey,
} from "../features/library/api";
import {
  accentColor,
  SPACE_ICON_KEYS,
  SPACE_ICONS,
} from "../features/library/spaceIcons";
import { IconButton } from "./IconButton";
import { isDuplicateSpaceName } from "../features/library/spaceEditorModel";

export type SpaceEditorMode = "create" | "edit";

type SpaceEditorDialogProps = {
  contentOffset: number;
  existingSpaces: Space[];
  mode: SpaceEditorMode;
  onOpenChange: (open: boolean) => void;
  onSubmit: (
    name: string,
    color: SpaceColorKey,
    icon: SpaceIconKey,
  ) => Promise<boolean>;
  open: boolean;
  space?: Space;
};

export function SpaceEditorDialog({
  contentOffset,
  existingSpaces,
  mode,
  onOpenChange,
  onSubmit,
  open,
  space,
}: SpaceEditorDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState<SpaceColorKey>("gray");
  const [icon, setIcon] = useState<SpaceIconKey>("heart");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(mode === "edit" ? (space?.name ?? "") : "");
    setColor(mode === "edit" ? (space?.colorKey ?? "gray") : "gray");
    setIcon(mode === "edit" ? (space?.iconKey ?? "heart") : "heart");
    setSubmitting(false);
    submittingRef.current = false;
  }, [mode, open, space]);

  const trimmedName = name.trim();
  const duplicate = isDuplicateSpaceName(existingSpaces, trimmedName, space?.id);
  const valid = trimmedName.length > 0 && !duplicate && !submitting;
  const SelectedIcon = SPACE_ICONS[icon];

  const submit = async () => {
    if (!valid || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    const saved = await onSubmit(trimmedName, color, icon);
    submittingRef.current = false;
    setSubmitting(false);
    if (saved) onOpenChange(false);
  };

  return (
    <Dialog.Root onOpenChange={onOpenChange} open={open}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/20" />
        <Dialog.Viewport
          className="fixed bottom-0 right-0 top-0 z-50 flex items-center justify-center p-6"
          style={{ left: contentOffset }}
        >
          <Dialog.Popup
            className="flex h-[280px] w-[460px] flex-col overflow-hidden rounded-xl border-[0.5px] border-border-1 bg-surface-1 outline-none [box-shadow:var(--shadow-menu)]"
            initialFocus={inputRef}
          >
            <header className="flex h-10 shrink-0 items-center gap-2.5 border-b-[0.5px] border-border-1 px-3 py-1.5">
              <Dialog.Title className="min-w-0 flex-1 text-xs font-medium leading-4 text-primary">
                {mode === "edit" ? "Edit Space" : "Create Space"}
              </Dialog.Title>
              <Dialog.Close
                render={<IconButton icon={X} label="Close Space editor" />}
              />
            </header>

            <section className="flex h-[52px] shrink-0 items-center p-3">
              <div className="flex w-full items-center gap-1.5">
                <div className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-lg border-[0.5px] border-border-1">
                  <SelectedIcon aria-hidden="true" size={16} strokeWidth={1.4} />
                </div>
                <input
                  aria-invalid={duplicate || undefined}
                  aria-label="Space name"
                  className="h-7 min-w-0 flex-1 rounded-lg border-[0.5px] border-border-1 bg-transparent px-3 py-1.5 text-xs font-normal leading-4 text-primary outline-none placeholder:text-tertiary focus:border-border-3"
                  onChange={(event) => setName(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void submit();
                    }
                  }}
                  placeholder="Enter space name..."
                  ref={inputRef}
                  value={name}
                />
              </div>
            </section>

            <fieldset className="flex h-[74px] shrink-0 flex-col gap-1.5 overflow-hidden p-3">
              <legend className="sr-only">Color</legend>
              <span className="text-[13px] font-normal leading-4 text-secondary">Color</span>
              <div className="flex w-full flex-nowrap gap-1.5">
                {COLOR_KEYS.map((key) => (
                  <button
                    aria-label={key[0].toUpperCase() + key.slice(1)}
                    aria-pressed={color === key}
                    className="flex size-7 shrink-0 items-center justify-center rounded-full"
                    key={key}
                    onClick={() => setColor(key)}
                    type="button"
                  >
                    <span
                      className="flex size-5 items-center justify-center rounded-full"
                      style={{ backgroundColor: accentColor(key) }}
                    >
                      {color === key ? (
                        <Check aria-hidden="true" className="text-white" size={12} strokeWidth={2} />
                      ) : null}
                    </span>
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset className="flex h-[74px] shrink-0 flex-col gap-1.5 overflow-hidden p-3">
              <legend className="sr-only">Icon</legend>
              <span className="text-[13px] font-normal leading-4 text-secondary">Icon</span>
              <div className="flex w-full flex-nowrap gap-1.5">
                {SPACE_ICON_KEYS.map((key) => {
                  const Icon = SPACE_ICONS[key];
                  const selected = icon === key;
                  return (
                    <button
                      aria-label={key}
                      aria-pressed={selected}
                      className={`flex size-7 shrink-0 items-center justify-center rounded-full ${selected ? "bg-selected" : "hover:bg-component-hover"}`}
                      key={key}
                      onClick={() => setIcon(key)}
                      type="button"
                    >
                      <Icon aria-hidden="true" size={16} strokeWidth={1.4} />
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <footer className="flex h-10 shrink-0 items-center justify-end gap-1.5 border-t-[0.5px] border-border-1 px-3 py-1.5">
              <Dialog.Close
                render={
                  <Button className="flex h-7 items-center justify-center rounded-full px-3 text-xs font-medium leading-4 text-secondary hover:bg-component-hover" type="button" />
                }
              >
                Cancel
              </Dialog.Close>
              <Button
                className="flex h-7 items-center justify-center rounded-full bg-accent px-3 text-xs font-medium leading-4 text-accent-foreground disabled:opacity-40"
                disabled={!valid}
                onClick={() => void submit()}
                type="button"
              >
                {mode === "edit" ? "Save" : "Create"}
              </Button>
            </footer>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
