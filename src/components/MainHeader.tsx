import {
  Archive,
  ArrowUpDown,
  LayoutGrid,
  Library,
  ListFilter,
  Star,
  type LucideIcon,
} from "lucide-react";
import type { AppLocation } from "../hooks/useNavigationHistory";
import { isSpaceLocation } from "../hooks/useNavigationHistory";
import type { Space } from "../features/library/api";
import { accentColor, SPACE_ICONS } from "../features/library/spaceIcons";
import {
  libraryViewPresentation,
  type LibraryViewIcon,
} from "../features/library/libraryViews";
import { AddMediaMenu, type AddMediaKind } from "./AddMediaMenu";
import { IconButton } from "./IconButton";

type MainHeaderProps = {
  activeLocation: AppLocation;
  isImporting: boolean;
  onAddMediaSelect: (kind: AddMediaKind) => void;
  onCreateLink: (url: string) => Promise<boolean>;
  sidebarCollapsed: boolean;
  activeSpace: Space | null;
};

const VIEW_ICONS: Record<Exclude<LibraryViewIcon, "space">, LucideIcon> = {
  archive: Archive,
  library: Library,
  star: Star,
};

export function MainHeader({
  activeLocation,
  isImporting,
  onAddMediaSelect,
  onCreateLink,
  sidebarCollapsed,
  activeSpace,
}: MainHeaderProps) {
  const presentation = libraryViewPresentation(activeLocation);
  const space = isSpaceLocation(activeLocation) ? activeSpace : null;
  const SectionIcon = space
    ? SPACE_ICONS[space.iconKey]
    : VIEW_ICONS[presentation.icon === "space" ? "library" : presentation.icon];
  return (
    <header
      className={`flex h-10 shrink-0 items-center justify-between border-b-[0.5px] border-border-1 py-1.5 pr-4 ${
        sidebarCollapsed ? "pl-[88px]" : "pl-4"
      }`}
      data-tauri-drag-region
    >
      <div className="flex items-center gap-1.5 font-medium text-primary">
        <SectionIcon
          aria-hidden="true"
          size={16}
          strokeWidth={1.4}
          style={space ? { color: accentColor(space.colorKey) } : undefined}
        />
        <span>{space?.name ?? presentation.label}</span>
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
