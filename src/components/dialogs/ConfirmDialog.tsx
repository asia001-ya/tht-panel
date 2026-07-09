/**
 * 通用确认对话框。
 * 受 uiStore.confirm 控制：confirm 为 null 时不渲染；有值时渲染模态。
 * 点击「确认」先执行调用方传入的 onConfirm 回调，再关闭确认框；
 * 点击「取消」或遮罩仅关闭。手写遮罩 + 模态，无 UI 组件库。
 */
import { useUiStore } from "../../store/uiStore";

/** 通用确认框组件 */
export default function ConfirmDialog() {
  // 确认框状态：null 表示未激活
  const confirm = useUiStore((s) => s.confirm);
  // 关闭确认框动作
  const closeConfirm = useUiStore((s) => s.closeConfirm);

  if (!confirm) return null;

  /** 点击确认：执行回调后关闭 */
  const handleConfirm = () => {
    confirm.onConfirm();
    closeConfirm();
  };

  return (
    <div className="dialog-overlay" onClick={closeConfirm}>
      <div
        className="dialog dialog-confirm"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">
          <h2 className="dialog-title">{confirm.title}</h2>
        </div>
        <div className="dialog-body">
          <p className="dialog-message">{confirm.message}</p>
        </div>
        <div className="dialog-footer">
          <button className="dialog-btn dialog-btn-ghost" onClick={closeConfirm}>
            取消
          </button>
          <button className="dialog-btn dialog-btn-primary" onClick={handleConfirm}>
            确认
          </button>
        </div>
      </div>
    </div>
  );
}
