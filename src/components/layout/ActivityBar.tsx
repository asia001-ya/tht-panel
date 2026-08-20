import {
  ChartLine,
  FolderKanban,
  Server,
  Settings,
  ICON_DEFAULTS,
} from "../ui/icons";
import { useUiStore, type MainView } from "../../store/uiStore";

interface ActivityButtonProps {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function ActivityButton({ label, active, onClick, children }: ActivityButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={`activity-bar-button${active ? " active" : ""}`}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** 参考 cc-pane 的窄竖向模块栏；重复点击当前模块会折叠/展开资源侧栏。 */
export function ActivityBar(): React.JSX.Element {
  const mainView = useUiStore((state) => state.mainView);
  const toggleMainView = useUiStore((state) => state.toggleMainView);
  const setView = (view: MainView): void => toggleMainView(view);

  return (
    <aside className="activity-bar" aria-label="应用模块">
      <div className="activity-bar-top">
        <ActivityButton label="工作空间" active={mainView === "panes"} onClick={() => setView("panes")}>
          <FolderKanban {...ICON_DEFAULTS} />
        </ActivityButton>
        <ActivityButton label="供应商" active={mainView === "providers"} onClick={() => setView("providers")}>
          <Server {...ICON_DEFAULTS} />
        </ActivityButton>
        <ActivityButton label="用量" active={mainView === "usage"} onClick={() => setView("usage")}>
          <ChartLine {...ICON_DEFAULTS} />
        </ActivityButton>
      </div>
      <div className="activity-bar-bottom">
        <ActivityButton label="设置" active={mainView === "settings"} onClick={() => setView("settings")}>
          <Settings {...ICON_DEFAULTS} />
        </ActivityButton>
      </div>
    </aside>
  );
}
