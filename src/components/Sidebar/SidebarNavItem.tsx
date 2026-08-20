/**
 * SidebarNavItem — 侧边栏顶部快捷导航项（32px 高，图标+文字，胶囊 hover）。
 * 视图类导航项传 active 标记当前页；命令类（新建/搜索等）不传。
 */
import type { ReactNode } from "react";

interface SidebarNavItemProps {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  /** 是否为当前激活视图，激活时高亮 */
  active?: boolean;
}

export function SidebarNavItem({
  icon,
  label,
  onClick,
  active,
}: SidebarNavItemProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={`sidebar-nav-item${active ? " active" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
