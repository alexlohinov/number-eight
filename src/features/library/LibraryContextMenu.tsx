import { ContextMenu } from "@base-ui/react/context-menu";
import { Check, ChevronRight, Plus } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  COLOR_KEYS,
  createLabelAndAssign,
  listLabels,
  listLabelsForItem,
  listSpacesForItem,
  setItemLabelMembership,
  setItemSpaceMembership,
  type Label,
  type Space,
  type SpaceColorKey,
} from "./api";
import type { LibraryCardItem } from "./LibraryCard";
import { libraryMenuGroups, type LibraryItemAction } from "./libraryMenu";
import { accentColor, SPACE_ICONS } from "./spaceIcons";
import { filterLabels, hasExactLabel, labelMenuVariant } from "./labelMenuModel";
import { showLibraryError } from "./useImportedImages";

export type { LibraryItemAction } from "./libraryMenu";

type LibraryContextMenuProps = {
  archived: boolean;
  children: ReactNode;
  disabled?: boolean;
  item: LibraryCardItem;
  onAction: (targetId: string, action: LibraryItemAction) => void;
  onCreateSpace: (targetId: string) => void;
  onMenuOpenChange: (open: boolean, targetId: string) => void;
  onSpaceMembershipChange: (targetId: string, spaceId: string, assigned: boolean) => void;
  shareAvailable: boolean;
  spaces: Space[];
};

const rowClass = "flex h-8 w-full cursor-default items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium leading-4 text-primary outline-none data-[highlighted]:bg-component-hover";
const popupClass = "overflow-hidden rounded-xl border-[0.5px] border-border-1 bg-surface-1 outline-none [box-shadow:var(--shadow-menu)]";

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
    <ContextMenu.SubmenuRoot onOpenChange={setOpen} open={open}>
      <ContextMenu.SubmenuTrigger className={rowClass} label="Add to Space" openOnHover>
        <span className="min-w-0 flex-1 font-medium">Add to Space</span>
        <ChevronRight aria-hidden="true" size={14} strokeWidth={1.4} />
      </ContextMenu.SubmenuTrigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-50" sideOffset={4}>
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

function LabelsSubmenu({ itemId }: { itemId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [labels, setLabels] = useState<Label[]>([]);
  const [assigned, setAssigned] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [state, setState] = useState<"list" | "pick-color">("list");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLabels([]);
    setAssigned(new Set());
    let active = true;
    Promise.all([listLabels(), listLabelsForItem(itemId)])
      .then(([all, selected]) => {
        if (!active) return;
        setLabels(all);
        setAssigned(new Set(selected.map((label) => label.id)));
      })
      .catch(() => showLibraryError("No. 8 couldn’t load Labels."));
    return () => { active = false; };
  }, [itemId, open]);

  const trimmed = query.trim();
  const filtered = filterLabels(labels, trimmed);
  const exact = hasExactLabel(labels, trimmed);

  const toggle = async (labelId: string) => {
    const wasAssigned = assigned.has(labelId);
    setAssigned((current) => {
      const next = new Set(current);
      if (wasAssigned) next.delete(labelId); else next.add(labelId);
      return next;
    });
    try {
      await setItemLabelMembership(itemId, labelId, !wasAssigned);
    } catch {
      setAssigned((current) => {
        const next = new Set(current);
        if (wasAssigned) next.add(labelId); else next.delete(labelId);
        return next;
      });
      await showLibraryError("No. 8 couldn’t update the Label membership.");
    }
  };

  const create = async (colorKey: SpaceColorKey) => {
    try {
      const label = await createLabelAndAssign(trimmed, colorKey, itemId);
      setLabels((current) => [...current, label]);
      setAssigned((current) => new Set(current).add(label.id));
      setQuery("");
      setState("list");
      requestAnimationFrame(() => inputRef.current?.focus());
    } catch {
      await showLibraryError("No. 8 couldn’t create the Label.");
    }
  };

  return (
    <ContextMenu.SubmenuRoot onOpenChange={(nextOpen) => {
      setOpen(nextOpen);
      if (nextOpen) requestAnimationFrame(() => inputRef.current?.focus());
      else { setQuery(""); setState("list"); }
    }} open={open}>
      <ContextMenu.SubmenuTrigger className={rowClass} label="Labels" openOnHover>
        <span className="min-w-0 flex-1 font-medium">Labels</span>
        <ChevronRight aria-hidden="true" size={14} strokeWidth={1.4} />
      </ContextMenu.SubmenuTrigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-50" sideOffset={4}>
          <ContextMenu.Popup
            className={`${popupClass} w-[257px] ${state === "pick-color" ? "h-[456px]" : "min-h-[72px]"}`}
            data-label-menu-variant={labelMenuVariant(labels, query, state === "pick-color")}
            onKeyDown={(event) => {
              if (event.key === "Escape" && state === "pick-color") {
                event.preventDefault();
                event.stopPropagation();
                setState("list");
                requestAnimationFrame(() => inputRef.current?.focus());
              }
            }}
          >
            {state === "list" ? (
              <>
                <input
                  aria-label="Search Labels"
                  className="h-8 w-full border-0 border-b-[0.5px] border-border-1 bg-transparent px-3 py-2 text-xs font-normal leading-4 text-primary outline-none placeholder:text-tertiary"
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") return;
                    event.stopPropagation();
                    if (event.key === "Enter") {
                      event.preventDefault();
                      if (trimmed && !exact) setState("pick-color");
                      else if (filtered[0]) void toggle(filtered[0].id);
                    }
                  }}
                  placeholder={labels.length > 0 ? "Search labels" : "Add labels..."}
                  ref={inputRef}
                  value={query}
                />
                <div className="flex flex-col p-1">
                  {filtered.map((label) => (
                    <ContextMenu.CheckboxItem
                      checked={assigned.has(label.id)}
                      className={rowClass}
                      closeOnClick={false}
                      key={label.id}
                      label={label.name}
                      onCheckedChange={() => void toggle(label.id)}
                    >
                      <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
                        <span className="size-2 rounded-full" style={{ backgroundColor: accentColor(label.colorKey) }} />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{label.name}</span>
                      <ContextMenu.CheckboxItemIndicator><Check aria-hidden="true" size={16} strokeWidth={1.4} /></ContextMenu.CheckboxItemIndicator>
                    </ContextMenu.CheckboxItem>
                  ))}
                  {!trimmed && labels.length === 0 ? (
                    <div className={`${rowClass} bg-selected text-tertiary`} aria-disabled="true">
                      <Plus aria-hidden="true" size={16} strokeWidth={1.4} />
                      <span className="min-w-0 flex-1 truncate">Start typing to create a new label</span>
                    </div>
                  ) : null}
                  {trimmed && !exact ? (
                    <ContextMenu.Item className={rowClass} closeOnClick={false} label={`Create new label: ${trimmed}`} onClick={() => setState("pick-color")}>
                      <Plus aria-hidden="true" size={16} strokeWidth={1.4} />
                      <span className="min-w-0 flex-1 truncate">Create new label:</span>
                      <span className="max-w-[112px] shrink-0 truncate text-xs font-normal text-tertiary">“{trimmed}”</span>
                    </ContextMenu.Item>
                  ) : null}
                </div>
              </>
            ) : (
              <>
                <div className="flex h-8 items-center border-b-[0.5px] border-border-1 px-3 py-2 text-xs font-normal leading-4 text-tertiary">
                  Pick color for label
                </div>
                <div className="flex flex-col p-1">
                  {COLOR_KEYS.map((key) => (
                    <ContextMenu.Item className={rowClass} closeOnClick={false} key={key} label={key} onClick={() => void create(key)}>
                      <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
                        <span className="size-2 rounded-full" style={{ backgroundColor: accentColor(key) }} />
                      </span>
                      <span className="min-w-0 flex-1">{key[0].toUpperCase() + key.slice(1)}</span>
                    </ContextMenu.Item>
                  ))}
                </div>
              </>
            )}
          </ContextMenu.Popup>
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
  onMenuOpenChange,
  onSpaceMembershipChange,
  shareAvailable,
  spaces,
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
        if (open || !pendingAction.current) return;
        const pending = pendingAction.current;
        pendingAction.current = null;
        onAction(pending.targetId, pending.action);
      }}
    >
      <ContextMenu.Trigger className="size-full">{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-40 outline-none">
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
                    <LabelsSubmenu itemId={targetIdRef.current} />
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
