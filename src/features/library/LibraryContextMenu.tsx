import { ContextMenu } from "@base-ui/react/context-menu";
import { Check, ChevronRight, Plus } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  listSpacesForItem,
  setItemSpaceMembership,
  type Label,
  type Space,
} from "./api";
import { LabelMenu } from "../../components/LabelMenu";
import type { LibraryCardItem } from "./LibraryCard";
import { libraryMenuGroups, type LibraryItemAction } from "./libraryMenu";
import { accentColor, SPACE_ICONS } from "./spaceIcons";
import { showLibraryError } from "./useImportedImages";
import { floatingSurfaceClassName } from "../../components/overlays/floatingSurfaceStyles";
import { overlayLayerStyles } from "../../components/overlays/overlayLayers";

export type { LibraryItemAction } from "./libraryMenu";

type LibraryContextMenuProps = {
  archived: boolean;
  children: ReactNode;
  disabled?: boolean;
  item: LibraryCardItem;
  onAction: (targetId: string, action: LibraryItemAction) => void;
  onCreateSpace: (targetId: string) => void;
  onLabelCreated: (label: Label) => void;
  onLabelMembershipChange: (targetId: string, labelId: string, assigned: boolean) => void;
  onMenuOpenChange: (open: boolean, targetId: string) => void;
  onMenuOpenChangeComplete: (open: boolean, targetId: string) => void;
  onSpaceMembershipChange: (targetId: string, spaceId: string, assigned: boolean) => void;
  open: boolean;
  shareAvailable: boolean;
  spaces: Space[];
  labels: Label[];
};

const rowClass = "flex h-8 w-full cursor-default items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium leading-4 text-primary outline-none data-[highlighted]:bg-component-hover";
const popupClass = `${floatingSurfaceClassName} outline-none`;

function SpaceSubmenu({ itemId, onCreateSpace, onMembershipChange, spaces }: { itemId: string; onCreateSpace: () => void; onMembershipChange: (spaceId: string, assigned: boolean) => void; spaces: Space[] }) {
  const [assigned, setAssigned] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAssigned(new Set());
    let active = true;
    listSpacesForItem(itemId)
      .then((items) => { if (active) setAssigned(new Set(items.map((space) => space.id))); })
      .catch(() => showLibraryError("No. 8 couldn’t load this item’s Spaces."));
    return () => { active = false; };
  }, [itemId, open]);

  const toggle = async (spaceId: string) => {
    const wasAssigned = assigned.has(spaceId);
    setAssigned((current) => {
      const next = new Set(current);
      if (wasAssigned) next.delete(spaceId); else next.add(spaceId);
      return next;
    });
    try {
      await setItemSpaceMembership(itemId, spaceId, !wasAssigned);
      onMembershipChange(spaceId, !wasAssigned);
    } catch {
      setAssigned((current) => {
        const next = new Set(current);
        if (wasAssigned) next.add(spaceId); else next.delete(spaceId);
        return next;
      });
      await showLibraryError("No. 8 couldn’t update the Space membership.");
    }
  };

  return (
    <ContextMenu.SubmenuRoot
      closeParentOnEsc={false}
      onOpenChange={setOpen}
      open={open}
    >
      <ContextMenu.SubmenuTrigger className={rowClass} label="Add to Space" openOnHover>
        <span className="min-w-0 flex-1 font-medium">Add to Space</span>
        <ChevronRight aria-hidden="true" size={14} strokeWidth={1.4} />
      </ContextMenu.SubmenuTrigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner sideOffset={4} style={overlayLayerStyles.floatingSubmenu}>
          <ContextMenu.Popup className={`${popupClass} w-[190px] p-1`}>
            {spaces.map((space) => {
              const Icon = SPACE_ICONS[space.iconKey];
              return (
                <ContextMenu.CheckboxItem
                  checked={assigned.has(space.id)}
                  className={rowClass}
                  closeOnClick={false}
                  key={space.id}
                  label={space.name}
                  onCheckedChange={() => void toggle(space.id)}
                >
                  <Icon aria-hidden="true" size={16} strokeWidth={1.4} style={{ color: accentColor(space.colorKey) }} />
                  <span className="min-w-0 flex-1 truncate font-medium">{space.name}</span>
                  <ContextMenu.CheckboxItemIndicator><Check aria-hidden="true" size={16} strokeWidth={1.4} /></ContextMenu.CheckboxItemIndicator>
                </ContextMenu.CheckboxItem>
              );
            })}
            <ContextMenu.Item className={rowClass} label="Create space" onClick={onCreateSpace}>
              <Plus aria-hidden="true" size={16} strokeWidth={1.4} />
              <span className="font-medium">Create space</span>
            </ContextMenu.Item>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.SubmenuRoot>
  );
}

function LabelsSubmenu({
  itemId,
  labels,
  onLabelCreated,
  onMembershipChange,
}: {
  itemId: string;
  labels: Label[];
  onLabelCreated: (label: Label) => void;
  onMembershipChange: (labelId: string, assigned: boolean) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <ContextMenu.SubmenuRoot
      closeParentOnEsc={false}
      onOpenChange={setOpen}
      open={open}
    >
      <ContextMenu.SubmenuTrigger className={rowClass} label="Labels" openOnHover>
        <span className="min-w-0 flex-1 font-medium">Labels</span>
        <ChevronRight aria-hidden="true" size={14} strokeWidth={1.4} />
      </ContextMenu.SubmenuTrigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner sideOffset={4} style={overlayLayerStyles.floatingSubmenu}>
          <ContextMenu.Popup
            render={
              <LabelMenu
                labels={labels}
                mode={{ type: "assign", itemId }}
                onLabelCreated={onLabelCreated}
                onMembershipChange={(_targetId, labelId, assigned) =>
                  onMembershipChange(labelId, assigned)
                }
                onRequestClose={() => setOpen(false)}
                open={open}
              />
            }
          />
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.SubmenuRoot>
  );
}

export function LibraryContextMenu({
  archived,
  children,
  disabled = false,
  item,
  onAction,
  onCreateSpace,
  onLabelCreated,
  onLabelMembershipChange,
  onMenuOpenChange,
  onMenuOpenChangeComplete,
  onSpaceMembershipChange,
  open,
  shareAvailable,
  spaces,
  labels,
}: LibraryContextMenuProps) {
  const pendingAction = useRef<{ action: LibraryItemAction; targetId: string } | null>(null);
  const targetIdRef = useRef(item.id);
  const groups = libraryMenuGroups(item, archived, shareAvailable);

  return (
    <ContextMenu.Root
      disabled={disabled}
      onOpenChange={(open) => {
        if (open) {
          pendingAction.current = null;
          targetIdRef.current = item.id;
        }
        onMenuOpenChange(open, targetIdRef.current);
      }}
      onOpenChangeComplete={(open) => {
        if (!open && pendingAction.current) {
          const pending = pendingAction.current;
          pendingAction.current = null;
          onAction(pending.targetId, pending.action);
        }
        onMenuOpenChangeComplete(open, targetIdRef.current);
      }}
      open={open}
    >
      <ContextMenu.Trigger className="size-full">{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner
          className="outline-none"
          style={overlayLayerStyles.floating}
        >
          <ContextMenu.Popup className={`${popupClass} w-[190px]`}>
            {groups.map((group, groupIndex) => (
              <ContextMenu.Group className="p-1" key={groupIndex}>
                {group.map(({ action, label, shortcut }) => (
                  <ContextMenu.Item
                    className={rowClass}
                    key={action}
                    label={label}
                    onClick={() => { pendingAction.current = { action, targetId: targetIdRef.current }; }}
                  >
                    <span className="min-w-0 flex-1 font-medium leading-4">{label}</span>
                    {shortcut ? <span aria-hidden="true" className="shrink-0 text-xs font-normal leading-4 tracking-normal text-tertiary">{shortcut}</span> : null}
                  </ContextMenu.Item>
                ))}
                {groupIndex === 1 ? (
                  <>
                    <SpaceSubmenu
                      itemId={targetIdRef.current}
                      onCreateSpace={() => onCreateSpace(targetIdRef.current)}
                      onMembershipChange={(spaceId, assigned) => onSpaceMembershipChange(targetIdRef.current, spaceId, assigned)}
                      spaces={spaces}
                    />
                    <LabelsSubmenu
                      itemId={targetIdRef.current}
                      labels={labels}
                      onLabelCreated={onLabelCreated}
                      onMembershipChange={(labelId, assigned) =>
                        onLabelMembershipChange(targetIdRef.current, labelId, assigned)
                      }
                    />
                  </>
                ) : null}
                {groupIndex < groups.length - 1 ? <ContextMenu.Separator className="mx-[-4px] mb-[-4px] mt-1 h-[0.5px] bg-border-1" /> : null}
              </ContextMenu.Group>
            ))}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
