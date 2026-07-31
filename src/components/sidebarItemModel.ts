export type SidebarItemVisualState = "default" | "hover" | "selected";

export const SIDEBAR_ITEM_STATE_CLASS_NAMES: Record<
  SidebarItemVisualState,
  string
> = {
  default:
    "bg-transparent text-secondary hover:bg-component-hover hover:text-primary",
  hover: "bg-component-hover text-primary",
  selected: "bg-selected text-primary",
};

export function resolveSidebarItemVisualState(
  selected: boolean,
  temporaryHover = false,
): SidebarItemVisualState {
  if (selected) return "selected";
  return temporaryHover ? "hover" : "default";
}
