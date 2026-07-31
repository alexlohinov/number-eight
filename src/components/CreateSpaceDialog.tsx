import { Button } from "@base-ui/react/button";
import { Dialog } from "@base-ui/react/dialog";
import { Check, X } from "lucide-react";
import { useRef, useState, type RefObject } from "react";
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
import {
  AppDialogBackdrop,
  AppDialogPopup,
  AppDialogViewport,
} from "./overlays/AppDialog";

export type SpaceEditorMode = "create" | "edit";

type SpaceEditorDialogProps = {
  contentOffset: number;
  existingSpaces: Space[];
  mode: SpaceEditorMode;
  finalFocusRef?: RefObject<HTMLElement | null>;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete: (open: boolean) => void;
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
  finalFocusRef,
  onOpenChange,
  onOpenChangeComplete,
  onSubmit,
  open,
  space,
}: SpaceEditorDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const editorKey = open
    ? `${mode}:${space?.id ?? "new"}`
    : "closed";
  return (
    <Dialog.Root
      onOpenChange={onOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
      open={open}
    >
      <Dialog.Portal>
        <AppDialogBackdrop />
        <AppDialogViewport
          className="flex items-center justify-center p-6"
          style={{ left: contentOffset }}
        >
          <AppDialogPopup
            className="flex h-[280px] w-[460px] flex-col outline-none"
            finalFocus={() => finalFocusRef?.current ?? true}
            initialFocus={inputRef}
          >
            <SpaceEditorDialogContent
              existingSpaces={existingSpaces}
              inputRef={inputRef}
              key={editorKey}
              mode={mode}
              onOpenChange={onOpenChange}
              onSubmit={onSubmit}
              space={space}
            />
          </AppDialogPopup>
        </AppDialogViewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SpaceEditorDialogContent({
  existingSpaces,
  inputRef,
  mode,
  onOpenChange,
  onSubmit,
  space,
}: Pick<
  SpaceEditorDialogProps,
  "existingSpaces" | "mode" | "onOpenChange" | "onSubmit" | "space"
> & { inputRef: RefObject<HTMLInputElement | null> }) {
  const submittingRef = useRef(false);
  const [name, setName] = useState(mode === "edit" ? (space?.name ?? "") : "");
  const [color, setColor] = useState<SpaceColorKey>(
    mode === "edit" ? (space?.colorKey ?? "gray") : "gray",
  );
  const [icon, setIcon] = useState<SpaceIconKey>(
    mode === "edit" ? (space?.iconKey ?? "heart") : "heart",
  );
  const [submitting, setSubmitting] = useState(false);

  const trimmedName = name.trim();
  const duplicate = isDuplicateSpaceName(existingSpaces, trimmedName, space?.id);
  const valid = trimmedName.length > 0 && !duplicate && !submitting;
  const SelectedIcon = SPACE_ICONS[icon];

  const submit = async () => {
    if (!valid || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    let saved = false;
    try {
      saved = await onSubmit(trimmedName, color, icon);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
    if (saved) onOpenChange(false);
  };

  return (
    <>
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
    </>
  );
}
