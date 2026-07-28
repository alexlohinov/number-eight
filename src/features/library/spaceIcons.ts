import {
  Brain,
  Briefcase,
  Flower2,
  Folder,
  Heart,
  MousePointerClick,
  Pencil,
  Popcorn,
  Sparkles,
  SquareTerminal,
  Target,
  Vault,
  type LucideIcon,
} from "lucide-react";
import type { SpaceColorKey, SpaceIconKey } from "./api";

export const SPACE_ICONS: Record<SpaceIconKey, LucideIcon> = {
  heart: Heart,
  flower: Flower2,
  brain: Brain,
  folder: Folder,
  pencil: Pencil,
  popcorn: Popcorn,
  "square-terminal": SquareTerminal,
  "mouse-pointer-click": MousePointerClick,
  sparkles: Sparkles,
  target: Target,
  "tool-case": Briefcase,
  vault: Vault,
};

export const SPACE_ICON_KEYS = Object.keys(SPACE_ICONS) as SpaceIconKey[];

export const accentColor = (key: SpaceColorKey) => `var(--accent-${key})`;
