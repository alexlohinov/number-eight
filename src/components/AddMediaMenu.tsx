import { Menu } from "@base-ui/react/menu";
import { Globe, Image, Plus, type LucideIcon } from "lucide-react";
import { useRef } from "react";
import { AddLinkPopover } from "./AddLinkPopover";
import { IconButton } from "./IconButton";
import { floatingSurfaceClassName } from "./overlays/floatingSurfaceStyles";
import { overlayLayerStyles } from "./overlays/overlayLayers";

export type AddMediaKind = "media" | "link";

type AddMediaMenuProps = {
  addLinkOpen: boolean;
  disabled?: boolean;
  menuOpen: boolean;
  onAddLinkOpenChange: (open: boolean) => void;
  onAddLinkOpenChangeComplete: (open: boolean) => void;
  onCreateLink: (url: string) => Promise<boolean>;
  onMenuOpenChange: (open: boolean) => void;
  onMenuOpenChangeComplete: (open: boolean) => void;
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
  addLinkOpen,
  disabled = false,
  menuOpen,
  onAddLinkOpenChange,
  onAddLinkOpenChangeComplete,
  onCreateLink,
  onMenuOpenChange,
  onMenuOpenChangeComplete,
  onSelect,
}: AddMediaMenuProps) {
  const pendingSelection = useRef<AddMediaKind | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <Menu.Root
        disabled={disabled}
        modal={false}
        onOpenChange={(nextOpen) => {
          if (nextOpen) {
            pendingSelection.current = null;
          }
          onMenuOpenChange(nextOpen);
        }}
        onOpenChangeComplete={(isOpen) => {
          if (!isOpen && pendingSelection.current) {
            const selection = pendingSelection.current;
            pendingSelection.current = null;
            onSelect?.(selection);
          }
          onMenuOpenChangeComplete(isOpen);
        }}
        open={menuOpen}
      >
        <Menu.Trigger
          render={
            <IconButton
              disabled={disabled}
              icon={Plus}
              label="Add media"
              ref={triggerRef}
              selected={menuOpen || addLinkOpen}
              variant="primary"
            />
          }
        />
        <Menu.Portal>
          <Menu.Positioner
            align="end"
            side="bottom"
            sideOffset={8}
            style={overlayLayerStyles.floating}
          >
            <Menu.Popup className={`${floatingSurfaceClassName} w-[190px] p-1 outline-none`}>
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
        onOpenChange={onAddLinkOpenChange}
        onOpenChangeComplete={onAddLinkOpenChangeComplete}
        open={addLinkOpen}
      />
    </>
  );
}
