/**
 * SidebarNavItem — 侧边栏顶部快捷导航项（32px 高，图标+文字，胶囊 hover）。
 */
import type { ReactNode } from "react";

interface SidebarNavItemProps {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}

export function SidebarNavItem({ icon, label, onClick }: SidebarNavItemProps): React.JSX.Element {
  return (
    <button type="button" className="sidebar-nav-item" onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}
