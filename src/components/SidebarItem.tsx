import { Button } from "@base-ui/react/button";
import type { LucideIcon } from "lucide-react";

type SidebarItemProps = {
  label: string;
  icon: LucideIcon;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
};

export function SidebarItem({
  label,
  icon: Icon,
  selected = false,
  disabled = false,
  onClick,
}: SidebarItemProps) {
  const stateClassName = selected
    ? "bg-selected text-primary"
    : "bg-transparent text-secondary hover:bg-component-hover hover:text-primary";

  return (
    <Button
      aria-current={selected ? "page" : undefined}
      className={`focus-ring flex w-full items-center gap-1.5 overflow-hidden rounded-lg px-2 py-1.5 text-left font-medium ${stateClassName}`}
      data-selected={selected || undefined}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <Icon aria-hidden="true" className="shrink-0" size={16} strokeWidth={1.4} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </Button>
  );
}
