/**
 * IconButton — 统一幽灵图标按钮（28×28，hover 填充，支持 danger 变体）。
 * 用法：<IconButton title="关闭" onClick={fn} danger><X {...ICON_DEFAULTS} /></IconButton>
 */
import type { ReactNode, MouseEvent } from "react";

interface IconButtonProps {
  children: ReactNode;
  title: string;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  danger?: boolean;
  className?: string;
}

export function IconButton({ children, title, onClick, disabled, danger, className }: IconButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={`icon-btn${danger ? " icon-btn-danger" : ""}${className ? ` ${className}` : ""}`}
      title={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
