import { useEffect, useRef } from "react";

export interface ContextMenuItem {
  id?: string;
  label: string;
  danger?: boolean;
  onClick: () => void;
}

export function ContextMenu({
  pos,
  items,
  onClose,
}: {
  pos: { x: number; y: number };
  items: ContextMenuItem[];
  onClose: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="ws-item-menu"
      style={{ left: pos.x, top: pos.y }}
    >
      {items.map((item) => (
        <button
          key={item.id ?? item.label}
          type="button"
          className={`ws-item-menu-btn${item.danger ? " ws-item-menu-danger" : ""}`}
          onClick={() => { item.onClick(); onClose(); }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
