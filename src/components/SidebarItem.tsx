import { Button } from "@base-ui/react/button";
import type { LucideIcon } from "lucide-react";
import type { CSSProperties } from "react";

type SidebarItemProps = {
  label: string;
  icon: LucideIcon;
  iconStyle?: CSSProperties;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
};

export function SidebarItem({
  label,
  icon: Icon,
  iconStyle,
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
      <Icon aria-hidden="true" className="shrink-0" size={16} strokeWidth={1.4} style={iconStyle} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </Button>
  );
}
