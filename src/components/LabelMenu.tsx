import { Check, Plus } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
} from "react";
import {
  COLOR_KEYS,
  createLabel,
  createLabelAndAssign,
  listLabelsForItem,
  setItemLabelMembership,
  type Label,
  type SpaceColorKey,
} from "../features/library/api";
import {
  clampLabelName,
  escapeLabelMenuState,
  filterLabels,
  isValidNewLabelName,
  labelCreateOperation,
  labelMenuVariant,
  moveLabelMenuActiveId,
  trimmedLabelName,
  type LabelMenuMode,
} from "../features/library/labelMenuModel";
import { accentColor } from "../features/library/spaceIcons";
import { showLibraryError } from "../features/library/useImportedImages";
import { floatingSurfaceClassName } from "./overlays/floatingSurfaceStyles";

export type { LabelMenuMode } from "../features/library/labelMenuModel";

type LabelMenuProps = Omit<HTMLAttributes<HTMLDivElement>, "onChange"> & {
  labels: Label[];
  mode: LabelMenuMode;
  onBrowseLabel?: (label: Label) => void;
  onLabelCreated: (label: Label) => void;
  onMembershipChange?: (
    itemId: string,
    labelId: string,
    assigned: boolean,
  ) => void;
  onRequestClose: () => void;
  open: boolean;
};

const rowClass =
  "flex h-8 w-full shrink-0 cursor-default items-center gap-1.5 rounded-lg border-0 p-2 text-left text-[13px] font-medium leading-4 text-primary outline-none data-[active]:bg-component-hover";

const rowId = (id: string) => `label-menu-row-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

type SetRowRef = (id: string, node: HTMLButtonElement | null) => void;

function LabelList({
  activeId,
  activate,
  assigned,
  canCreate,
  filtered,
  mode,
  setActiveId,
  setRowRef,
  trimmed,
}: {
  activeId: string | null;
  activate: (id: string) => void;
  assigned: Set<string>;
  canCreate: boolean;
  filtered: Label[];
  mode: LabelMenuMode;
  setActiveId: (id: string) => void;
  setRowRef: SetRowRef;
  trimmed: string;
}) {
  return (
    <>
      {filtered.map((label) => {
        const id = `label:${label.id}`;
        const checked =
          mode.type === "assign"
            ? assigned.has(label.id)
            : mode.activeLabelId === label.id;
        return (
          <button
            aria-checked={checked}
            className={rowClass}
            data-active={activeId === id || undefined}
            id={rowId(id)}
            key={label.id}
            onClick={() => activate(id)}
            onPointerDown={(event) => event.preventDefault()}
            onPointerMove={() => setActiveId(id)}
            ref={(node) => setRowRef(id, node)}
            role={mode.type === "assign" ? "menuitemcheckbox" : "menuitemradio"}
            type="button"
          >
            <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
              <span className="size-2 rounded-full" style={{ backgroundColor: accentColor(label.colorKey) }} />
            </span>
            <span className="min-w-0 flex-1 truncate">{label.name}</span>
            {checked ? <Check aria-hidden="true" className="shrink-0" size={16} strokeWidth={1.4} /> : null}
          </button>
        );
      })}
      {!trimmed && filtered.length === 0 ? (
        <div
          aria-disabled="true"
          className={`${rowClass} bg-selected text-tertiary`}
          role="note"
        >
          <Plus aria-hidden="true" className="shrink-0" size={16} strokeWidth={1.4} />
          <span className="min-w-0 flex-1 truncate">Start typing to create a new label</span>
        </div>
      ) : null}
      {canCreate ? (
        <button
          className={rowClass}
          data-active={activeId === "create" || undefined}
          id={rowId("create")}
          onClick={() => activate("create")}
          onPointerDown={(event) => event.preventDefault()}
          onPointerMove={() => setActiveId("create")}
          ref={(node) => setRowRef("create", node)}
          role="menuitem"
          type="button"
        >
          <Plus aria-hidden="true" className="shrink-0" size={16} strokeWidth={1.4} />
          <span className="min-w-0 flex-1 truncate">Create new label:</span>
          <span className="max-w-[112px] shrink-0 truncate text-xs font-normal text-tertiary">“{trimmed}”</span>
        </button>
      ) : null}
    </>
  );
}

function LabelColorList({
  activeId,
  activate,
  setActiveId,
  setRowRef,
}: {
  activeId: string | null;
  activate: (id: string) => void;
  setActiveId: (id: string) => void;
  setRowRef: SetRowRef;
}) {
  return COLOR_KEYS.map((key) => {
    const id = `color:${key}`;
    return (
      <button
        className={rowClass}
        data-active={activeId === id || undefined}
        id={rowId(id)}
        key={key}
        onClick={() => activate(id)}
        onPointerDown={(event) => event.preventDefault()}
        onPointerMove={() => setActiveId(id)}
        ref={(node) => setRowRef(id, node)}
        role="menuitem"
        type="button"
      >
        <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
          <span className="size-2 rounded-full" style={{ backgroundColor: accentColor(key) }} />
        </span>
        <span className="min-w-0 flex-1">{key[0].toUpperCase() + key.slice(1)}</span>
      </button>
    );
  });
}

const LabelMenuContent = forwardRef<HTMLDivElement, LabelMenuProps>(
  function LabelMenuContent(
    {
      className,
      labels,
      mode,
      onBrowseLabel,
      onLabelCreated,
      onMembershipChange,
      onRequestClose,
      open,
      ...props
    },
    forwardedRef,
  ) {
    const inputRef = useRef<HTMLInputElement>(null);
    const listId = useId();
    const colorMenuRef = useRef<HTMLDivElement>(null);
    const rowRefs = useRef(new Map<string, HTMLButtonElement>());
    const creatingRef = useRef(false);
    const pendingMemberships = useRef(new Set<string>());
    const [assigned, setAssigned] = useState<Set<string>>(new Set());
    const [query, setQuery] = useState("");
    const [state, setState] = useState<"list" | "pick-color">("list");
    const [activeId, setActiveId] = useState<string | null>(null);
    const assignItemId = mode.type === "assign" ? mode.itemId : null;

    useEffect(() => {
      if (!open || assignItemId === null) return;
      let active = true;
      listLabelsForItem(assignItemId)
        .then((items) => {
          if (active) setAssigned(new Set(items.map((label) => label.id)));
        })
        .catch(() => showLibraryError("No. 8 couldn’t load this item’s Labels."));
      return () => {
        active = false;
      };
    }, [assignItemId, open]);

    useLayoutEffect(() => {
      if (!open) return;
      if (state === "pick-color") colorMenuRef.current?.focus();
      else inputRef.current?.focus();
    }, [open, state]);

    const trimmed = trimmedLabelName(query);
    const filtered = useMemo(
      () => filterLabels(labels, query),
      [labels, query],
    );
    const canCreate = isValidNewLabelName(labels, query);
    const selectableIds = useMemo(
      () =>
        state === "pick-color"
          ? COLOR_KEYS.map((key) => `color:${key}`)
          : [
              ...filtered.map((label) => `label:${label.id}`),
              ...(canCreate ? ["create"] : []),
            ],
      [canCreate, filtered, state],
    );

    useEffect(() => {
      setActiveId(selectableIds[0] ?? null);
    }, [selectableIds]);

    useEffect(() => {
      if (!activeId) return;
      rowRefs.current.get(activeId)?.scrollIntoView({ block: "nearest" });
    }, [activeId]);

    const toggle = async (labelId: string) => {
      if (mode.type !== "assign" || pendingMemberships.current.has(labelId)) return;
      const itemId = mode.itemId;
      const wasAssigned = assigned.has(labelId);
      pendingMemberships.current.add(labelId);
      setAssigned((current) => {
        const next = new Set(current);
        if (wasAssigned) next.delete(labelId);
        else next.add(labelId);
        return next;
      });
      try {
        await setItemLabelMembership(itemId, labelId, !wasAssigned);
        onMembershipChange?.(itemId, labelId, !wasAssigned);
      } catch {
        setAssigned((current) => {
          const next = new Set(current);
          if (wasAssigned) next.add(labelId);
          else next.delete(labelId);
          return next;
        });
        await showLibraryError("No. 8 couldn’t update the Label membership.");
      } finally {
        pendingMemberships.current.delete(labelId);
      }
    };

    const create = async (colorKey: SpaceColorKey) => {
      if (!isValidNewLabelName(labels, query) || creatingRef.current) return;
      creatingRef.current = true;
      try {
        const operation = labelCreateOperation(mode, trimmed, colorKey);
        const label = operation.type === "create-and-assign"
          ? await createLabelAndAssign(
              operation.name,
              operation.colorKey,
              operation.itemId,
            )
          : await createLabel(operation.name, operation.colorKey);
        onLabelCreated(label);
        if (mode.type === "assign") {
          setAssigned((current) => new Set(current).add(label.id));
          onMembershipChange?.(mode.itemId, label.id, true);
        }
        setQuery("");
        setState("list");
      } catch {
        await showLibraryError("No. 8 couldn’t create the Label.");
      } finally {
        creatingRef.current = false;
      }
    };

    const activate = (id: string | null) => {
      if (!id) return;
      if (id === "create") {
        setState("pick-color");
        return;
      }
      if (id.startsWith("color:")) {
        void create(id.slice("color:".length) as SpaceColorKey);
        return;
      }
      const label = labels.find((candidate) => `label:${candidate.id}` === id);
      if (!label) return;
      if (mode.type === "assign") void toggle(label.id);
      else {
        onBrowseLabel?.(label);
        onRequestClose();
      }
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (escapeLabelMenuState(state) === "list") setState("list");
        else onRequestClose();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setActiveId((current) =>
          moveLabelMenuActiveId(
            selectableIds,
            current,
            event.key === "ArrowDown" ? 1 : -1,
          ),
        );
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        event.stopPropagation();
        setActiveId(
          event.key === "Home"
            ? selectableIds[0] ?? null
            : selectableIds.at(-1) ?? null,
        );
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        activate(activeId);
        return;
      }
      event.stopPropagation();
    };

    const setRowRef = (id: string, node: HTMLButtonElement | null) => {
      if (node) rowRefs.current.set(id, node);
      else rowRefs.current.delete(id);
    };

    const variant = labelMenuVariant(labels, query, state === "pick-color");

    return (
      <div
        {...props}
        aria-label={mode.type === "assign" ? "Assign Labels" : "Browse Labels"}
        className={`${floatingSurfaceClassName} flex w-[257px] flex-col items-start outline-none ${
          state === "pick-color" ? "h-[456px]" : "max-h-[456px] min-h-[72px]"
        } ${className ?? ""}`}
        data-label-menu-mode={mode.type}
        data-label-menu-variant={variant}
        onContextMenu={(event) => {
          if ((event.target as Element).closest("input")) return;
          event.preventDefault();
        }}
        ref={forwardedRef}
      >
        {state === "list" ? (
          <input
            aria-activedescendant={activeId ? rowId(activeId) : undefined}
            aria-controls={listId}
            aria-label="Search Labels"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            className="h-8 w-full shrink-0 appearance-none border-0 border-b-[0.5px] border-border-1 bg-transparent px-3 py-2 text-xs font-normal leading-4 tracking-normal text-primary outline-none [box-shadow:none] placeholder:text-tertiary focus:outline-none focus:[box-shadow:none] focus-visible:outline-none focus-visible:[box-shadow:none]"
            onChange={(event) => setQuery(clampLabelName(event.currentTarget.value))}
            onContextMenu={(event) => event.stopPropagation()}
            onKeyDown={handleKeyDown}
            placeholder={labels.length > 0 ? "Search labels" : "Add labels..."}
            ref={inputRef}
            spellCheck={false}
            value={query}
          />
        ) : (
          <div
            className="flex h-8 w-full shrink-0 items-center border-b-[0.5px] border-border-1 px-3 py-2 text-xs font-normal leading-4 text-tertiary outline-none"
          >
            Pick color for label
          </div>
        )}

        <div
          aria-activedescendant={
            state === "pick-color" && activeId ? rowId(activeId) : undefined
          }
          aria-label={selectableIds.length > 0 ? "Labels" : undefined}
          className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto p-1"
          id={listId}
          onKeyDown={state === "pick-color" ? handleKeyDown : undefined}
          ref={state === "pick-color" ? colorMenuRef : undefined}
          role={selectableIds.length > 0 ? "menu" : "presentation"}
          tabIndex={state === "pick-color" ? -1 : undefined}
        >
          {state === "list" ? (
            <LabelList
              activeId={activeId}
              activate={activate}
              assigned={assigned}
              canCreate={canCreate}
              filtered={filtered}
              mode={mode}
              setActiveId={setActiveId}
              setRowRef={setRowRef}
              trimmed={trimmed}
            />
          ) : (
            <LabelColorList
              activeId={activeId}
              activate={activate}
              setActiveId={setActiveId}
              setRowRef={setRowRef}
            />
          )}
        </div>
      </div>
    );
  },
);

export const LabelMenu = forwardRef<HTMLDivElement, LabelMenuProps>(
  function LabelMenu({ mode, open, ...props }, forwardedRef) {
    const modeKey = mode.type === "assign"
      ? `assign:${mode.itemId}`
      : `browse:${mode.activeLabelId ?? "none"}`;
    return (
      <LabelMenuContent
        {...props}
        key={`${open ? "open" : "closed"}:${modeKey}`}
        mode={mode}
        open={open}
        ref={forwardedRef}
      />
    );
  },
);
