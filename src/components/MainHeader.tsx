import { ArrowUpDown, LayoutGrid, Library, ListFilter } from "lucide-react";
import { AddMediaMenu, type AddMediaKind } from "./AddMediaMenu";
import { IconButton } from "./IconButton";

type MainHeaderProps = {
  isImporting: boolean;
  onAddMediaSelect: (kind: AddMediaKind) => void;
  onCreateLink: (url: string) => Promise<boolean>;
  sidebarCollapsed: boolean;
};

export function MainHeader({
  isImporting,
  onAddMediaSelect,
  onCreateLink,
  sidebarCollapsed,
}: MainHeaderProps) {
  return (
    <header
      className={`flex h-10 shrink-0 items-center justify-between border-b-[0.5px] border-border-1 py-1.5 pr-4 ${
        sidebarCollapsed ? "pl-[88px]" : "pl-4"
      }`}
      data-tauri-drag-region
    >
      <div className="flex items-center gap-1.5 font-medium text-primary">
        <Library aria-hidden="true" size={16} strokeWidth={1.4} />
        <span>All</span>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5">
          <IconButton disabled icon={ListFilter} label="Filter library" />
          <IconButton disabled icon={ArrowUpDown} label="Sort library" />
          <IconButton disabled icon={LayoutGrid} label="Change view" />
        </div>
        <span aria-hidden="true" className="h-4 w-px rounded-full bg-border-1" />
        <AddMediaMenu
          disabled={isImporting}
          onCreateLink={onCreateLink}
          onSelect={onAddMediaSelect}
        />
      </div>
    </header>
  );
}
