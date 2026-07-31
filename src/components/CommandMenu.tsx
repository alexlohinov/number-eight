import { Dialog } from "@base-ui/react/dialog";
import { Globe, Image, type LucideIcon } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
} from "react";
import {
  filterCommands,
  spaceCommandId,
  type ExecutableAppCommandId,
  type CommandDefinition,
} from "../features/command-menu/commandRegistry";
import {
  filterSpaces,
  firstSelectableResultId,
  isCurrentRequest,
  moveActiveResult,
  normalizedSearchQuery,
  optionDomId,
  selectableResultIds,
} from "../features/command-menu/commandMenuModel";
import {
  listRecentItems,
  searchItems,
  type LibraryItem,
  type Space,
} from "../features/library/api";
import { accentColor, SPACE_ICONS } from "../features/library/spaceIcons";
import {
  AppDialogBackdrop,
  AppDialogPopup,
  AppDialogViewport,
} from "./overlays/AppDialog";
import { showLibraryError } from "../features/library/useImportedImages";

const SEARCH_DEBOUNCE_MS = 150;
const OPTIONS_ID = "command-menu-options";

export type CommandMenuExecution =
  | {
      id: string;
      kind: "action" | "navigation";
      commandId: ExecutableAppCommandId;
    }
  | {
      id: string;
      kind: "item";
      run: () => void | Promise<void>;
    };

type CommandMenuProps = {
  commands: CommandDefinition[];
  finalFocusRef: RefObject<HTMLElement | null>;
  onExecute: (execution: CommandMenuExecution) => void;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete: (open: boolean) => void;
  onOpenItem: (id: string) => void | Promise<void>;
  open: boolean;
  spaces: Space[];
};

type MenuResult = {
  id: string;
  title: string;
  icon: LucideIcon;
  iconStyle?: CSSProperties;
  trailing?: string;
  disabled?: boolean;
  kind: CommandMenuExecution["kind"];
  execution: CommandMenuExecution;
};

type MenuSection = {
  id: string;
  label: string;
  results: MenuResult[];
  status?: "Searching…";
};

function hostname(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function itemMetadata(item: LibraryItem) {
  if (item.archivedAtMs !== null) return "Archived";
  return item.itemType === "image" ? "Image" : hostname(item.url);
}

function itemResult(
  item: LibraryItem,
  onOpenItem: (id: string) => void | Promise<void>,
): MenuResult {
  return {
    id: `item:${item.id}`,
    title: item.title,
    icon: item.itemType === "image" ? Image : Globe,
    trailing: itemMetadata(item),
    kind: "item",
    execution: {
      id: `item:${item.id}`,
      kind: "item",
      run: () => onOpenItem(item.id),
    },
  };
}

function commandResult(command: CommandDefinition): MenuResult {
  return {
    id: `command:${command.id}`,
    title: command.title,
    icon: command.icon,
    trailing: command.shortcut?.label,
    disabled: !command.enabled,
    kind: command.section === "actions" ? "action" : "navigation",
    execution: {
      id: `command:${command.id}`,
      kind: command.section === "actions" ? "action" : "navigation",
      commandId: command.id,
    },
  };
}

function spaceResult(space: Space): MenuResult {
  return {
    id: `space:${space.id}`,
    title: space.name,
    icon: SPACE_ICONS[space.iconKey],
    iconStyle: { color: accentColor(space.colorKey) },
    kind: "navigation",
    execution: {
      id: `space:${space.id}`,
      kind: "navigation",
      commandId: spaceCommandId(space.id),
    },
  };
}

export function CommandMenu({
  onOpenChange,
  onOpenChangeComplete,
  open,
  ...props
}: CommandMenuProps) {
  return (
    <CommandMenuContent
      {...props}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
      open={open}
    />
  );
}

function CommandMenuContent({
  commands,
  finalFocusRef,
  onExecute,
  onOpenChange,
  onOpenChangeComplete,
  onOpenItem,
  open,
  spaces,
}: CommandMenuProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRequest = useRef(0);
  const recentRequest = useRef(0);
  const reportedSearchError = useRef(false);
  const [query, setQuery] = useState("");
  const [recentItems, setRecentItems] = useState<LibraryItem[]>([]);
  const [matchedItems, setMatchedItems] = useState<LibraryItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const trimmedQuery = normalizedSearchQuery(query);

  useEffect(() => {
    if (!open) return;

    const request = ++recentRequest.current;
    listRecentItems(5)
      .then(({ items }) => {
        if (isCurrentRequest(recentRequest.current, request)) setRecentItems(items);
      })
      .catch(() => {
        if (isCurrentRequest(recentRequest.current, request)) {
          void showLibraryError("No. 8 couldn’t load recent items.");
        }
      });
    return () => {
      recentRequest.current += 1;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !trimmedQuery) {
      searchRequest.current += 1;
      return;
    }

    const request = ++searchRequest.current;
    setSearching(true);
    const timer = window.setTimeout(() => {
      searchItems(trimmedQuery, 30)
        .then(({ items }) => {
          if (!isCurrentRequest(searchRequest.current, request)) return;
          setMatchedItems(items);
          setSearching(false);
        })
        .catch(() => {
          if (!isCurrentRequest(searchRequest.current, request)) return;
          setMatchedItems([]);
          setSearching(false);
          if (!reportedSearchError.current) {
            reportedSearchError.current = true;
            void showLibraryError("No. 8 couldn’t search the library.");
          }
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [open, trimmedQuery]);

  const sections = useMemo<MenuSection[]>(() => {
    if (!trimmedQuery) {
      const actionResults: MenuResult[] = [];
      const navigationResults: MenuResult[] = [];
      for (const command of commands) {
        if (command.section === "actions") actionResults.push(commandResult(command));
        else if (command.section === "navigation") {
          navigationResults.push(commandResult(command));
        }
      }
      const spaceResults = spaces.map(spaceResult);
      const recentResults = recentItems.map((item) => itemResult(item, onOpenItem));
      return [
        { id: "actions", label: "Actions", results: actionResults },
        { id: "navigation", label: "Navigation", results: navigationResults },
        { id: "spaces", label: "Spaces", results: spaceResults },
        { id: "recent", label: "Recent", results: recentResults },
      ].filter((section) => section.results.length > 0);
    }

    const itemResults = matchedItems.map((item) => itemResult(item, onOpenItem));
    const spaceResults = filterSpaces(spaces, trimmedQuery).map(spaceResult);
    const commandResults = filterCommands(commands, trimmedQuery).map(commandResult);
    return [
      {
        id: "items",
        label: "Items",
        results: searching ? [] : itemResults,
        status: searching ? "Searching…" : undefined,
      },
      { id: "spaces", label: "Spaces", results: spaceResults },
      { id: "commands", label: "Commands", results: commandResults },
    ].filter((section) => section.results.length > 0 || section.status);
  }, [commands, matchedItems, onOpenItem, recentItems, searching, spaces, trimmedQuery]);

  const results = useMemo(() => sections.flatMap((section) => section.results), [sections]);
  const selectableIds = useMemo(() => selectableResultIds(results), [results]);
  const resultKey = selectableIds.join("\u0000");

  useEffect(() => {
    setActiveId(firstSelectableResultId(results));
  }, [resultKey, results]);

  useEffect(() => {
    if (!activeId) return;
    document.getElementById(optionDomId(activeId))?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const activeResult = results.find((result) => result.id === activeId) ?? null;
  const execute = (result: MenuResult | null) => {
    if (!result || result.disabled) return;
    onExecute(result.execution);
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveId((current) => moveActiveResult(selectableIds, current, 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveId((current) => moveActiveResult(selectableIds, current, -1));
        break;
      case "Home":
        event.preventDefault();
        setActiveId(selectableIds[0] ?? null);
        break;
      case "End":
        event.preventDefault();
        setActiveId(selectableIds.at(-1) ?? null);
        break;
      case "Enter":
        event.preventDefault();
        execute(activeResult);
        break;
    }
  };

  const showNoResults = Boolean(trimmedQuery) && sections.length === 0;

  const handleOpenChangeComplete = (nextOpen: boolean) => {
    if (!nextOpen) {
      searchRequest.current += 1;
      recentRequest.current += 1;
      reportedSearchError.current = false;
      setQuery("");
      setRecentItems([]);
      setMatchedItems([]);
      setSearching(false);
      setActiveId(null);
    }
    onOpenChangeComplete(nextOpen);
  };

  return (
    <Dialog.Root
      modal
      onOpenChange={onOpenChange}
      onOpenChangeComplete={handleOpenChangeComplete}
      open={open}
    >
      <Dialog.Portal>
        <AppDialogBackdrop />
        <AppDialogViewport className="flex items-center justify-center p-4">
          <AppDialogPopup
            className="flex h-[min(490px,calc(100vh-32px))] w-[min(520px,calc(100vw-32px))] flex-col outline-none"
            finalFocus={() => finalFocusRef.current ?? true}
            initialFocus={inputRef}
          >
            <Dialog.Title className="sr-only">Search and commands</Dialog.Title>
            <div className="flex h-10 shrink-0 items-center gap-1.5 border-b-[0.5px] border-border-1 px-3 py-2.5">
              <input
                aria-activedescendant={activeResult ? optionDomId(activeResult.id) : undefined}
                aria-autocomplete="list"
                aria-controls={OPTIONS_ID}
                aria-expanded="true"
                aria-label="Search and commands"
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect="off"
                className="w-full min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 text-xs font-normal leading-4 tracking-normal text-primary outline-none [box-shadow:none] placeholder:text-tertiary focus:outline-none focus:[box-shadow:none] focus-visible:outline-none focus-visible:[box-shadow:none]"
                onChange={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={handleInputKeyDown}
                placeholder="Type a command or search…"
                ref={inputRef}
                role="combobox"
                spellCheck={false}
                value={query}
              />
              <span
                aria-hidden="true"
                className="shrink-0 rounded-md bg-foreground-2 p-0.5 text-center text-xs font-medium leading-4 tracking-normal text-secondary"
              >
                ESC
              </span>
            </div>

            <div
              aria-busy={searching || undefined}
              className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-1"
              id={OPTIONS_ID}
              role="listbox"
            >
              {sections.map((section) => (
                <div key={section.id} role="presentation">
                  <div className="flex h-7 items-center rounded-lg px-2 py-1.5 text-[13px] font-medium leading-4 text-secondary" role="presentation">
                    {section.label}
                  </div>
                  {section.status ? (
                    <div className="flex h-8 items-center rounded-lg px-2 text-[13px] font-medium leading-4 text-tertiary" role="status">
                      {section.status}
                    </div>
                  ) : null}
                  {section.results.map((result) => {
                    const Icon = result.icon;
                    const active = activeId === result.id;
                    return (
                      <div
                        aria-disabled={result.disabled || undefined}
                        aria-selected={active}
                        className={`flex h-8 items-center gap-1.5 rounded-lg p-2 text-[13px] font-medium leading-4 outline-none ${
                          active ? "bg-component-hover" : ""
                        } ${result.disabled ? "text-disabled" : "text-primary"}`}
                        id={optionDomId(result.id)}
                        key={result.id}
                        onClick={() => execute(result)}
                        onPointerDown={(event) => event.preventDefault()}
                        onPointerMove={() => {
                          if (!result.disabled) setActiveId(result.id);
                        }}
                        role="option"
                      >
                        <Icon
                          aria-hidden="true"
                          className="shrink-0"
                          size={16}
                          strokeWidth={1.4}
                          style={result.iconStyle}
                        />
                        <span className="min-w-0 flex-1 truncate">{result.title}</span>
                        {result.trailing ? (
                          <span className="max-w-[180px] shrink-0 truncate text-[13px] font-medium leading-4 text-tertiary">
                            {result.trailing}
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ))}
              {showNoResults ? (
                <div className="flex h-8 items-center rounded-lg px-2 text-[13px] font-medium leading-4 text-tertiary" role="status">
                  No results
                </div>
              ) : null}
            </div>

            <footer className="flex shrink-0 items-center justify-between border-t-[0.5px] border-border-1 px-3 py-2 text-xs font-normal leading-4 tracking-normal text-secondary">
              <span className="flex items-center gap-1.5">
                <span className="rounded-md bg-foreground-2 p-0.5 font-medium">↑↓</span>
                Navigate
              </span>
              <span className="flex items-center gap-1.5">
                <span className="rounded-md bg-foreground-2 p-0.5 font-medium">↵</span>
                {activeResult?.kind === "action" ? "Run" : "Open"}
              </span>
            </footer>
            <Dialog.Close className="sr-only">Close Search and commands</Dialog.Close>
          </AppDialogPopup>
        </AppDialogViewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
