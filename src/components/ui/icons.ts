/**
 * 项目图标统一再导出。全部使用 lucide-react，默认 size=16 strokeWidth=1.5。
 * 组件内直接 import { XxxIcon } from "../../components/ui/icons" 使用。
 */
export {
  ChevronRight,
  Plus,
  RotateCw,
  X,
  Sun,
  Moon,
  Settings,
  Lock,
  LockOpen,
  Columns2,
  Rows2,
  ArrowUp,
  ArrowDown,
  Search,
  SquareTerminal,
  SquarePen,
  Ellipsis,
  ChevronDown,
  ChevronUp,
  Folder,
  FolderOpen,
  Send,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Trash2,
  GripVertical,
  LayoutTemplate,
  Save,
  Server,
  ListTodo,
} from "lucide-react";

/** 全局图标默认 props */
export const ICON_DEFAULTS = { size: 16, strokeWidth: 1.5 } as const;
