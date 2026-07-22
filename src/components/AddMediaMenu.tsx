import { Menu } from "@base-ui/react/menu";
import { Globe, Image, Plus, type LucideIcon } from "lucide-react";
import { useRef, useState } from "react";
import { AddLinkPopover } from "./AddLinkPopover";
import { IconButton } from "./IconButton";

export type AddMediaKind = "media" | "link";

type AddMediaMenuProps = {
  disabled?: boolean;
  onCreateLink: (url: string) => Promise<boolean>;
  onSelect?: (kind: AddMediaKind) => void;
};

type AddMediaOption = {
  id: AddMediaKind;
  label: string;
  shortcut: string;
  icon: LucideIcon;
};

const addMediaOptions: AddMediaOption[] = [
  { id: "media", label: "Media", shortcut: "M", icon: Image },
  { id: "link", label: "Link", shortcut: "L", icon: Globe },
];

export function AddMediaMenu({
  disabled = false,
  onCreateLink,
  onSelect,
}: AddMediaMenuProps) {
  const [open, setOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const pendingSelection = useRef<AddMediaKind | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <Menu.Root
        disabled={disabled}
        onOpenChange={(nextOpen) => {
          if (nextOpen) {
            pendingSelection.current = null;
          }
          setOpen(nextOpen);
        }}
        onOpenChangeComplete={(isOpen) => {
          if (!isOpen && pendingSelection.current) {
            const selection = pendingSelection.current;
            pendingSelection.current = null;
            if (selection === "link") {
              setLinkOpen(true);
            } else {
              onSelect?.(selection);
            }
          }
        }}
        open={open}
      >
        <Menu.Trigger
          render={
            <IconButton
              disabled={disabled}
              icon={Plus}
              label="Add media"
              ref={triggerRef}
              selected={open || linkOpen}
              variant="primary"
            />
          }
        />
        <Menu.Portal>
          <Menu.Positioner align="end" className="z-30" side="bottom" sideOffset={8}>
            <Menu.Popup className="w-[190px] overflow-hidden rounded-xl border-[0.5px] border-border-1 bg-surface-1 p-1 outline-none [box-shadow:var(--shadow-menu)]">
              {addMediaOptions.map(({ id, icon: Icon, label, shortcut }) => (
                <Menu.Item
                  className="flex h-8 w-full cursor-default items-center gap-1.5 rounded-lg px-2 text-primary outline-none hover:bg-component-hover data-[highlighted]:bg-component-hover dark:hover:bg-selected dark:data-[highlighted]:bg-selected"
                  key={id}
                  label={label}
                  onClick={() => {
                    pendingSelection.current = id;
                  }}
                >
                  <Icon aria-hidden="true" className="shrink-0" size={16} strokeWidth={1.4} />
                  <span className="min-w-0 flex-1 font-medium leading-4">{label}</span>
                  <span
                    aria-hidden="true"
                    className="w-4 shrink-0 text-center text-xs leading-4 tracking-normal text-tertiary"
                  >
                    {shortcut}
                  </span>
                </Menu.Item>
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <AddLinkPopover
        anchorRef={triggerRef}
        onCreate={onCreateLink}
        onOpenChange={setLinkOpen}
        open={linkOpen}
      />
    </>
  );
}
