/** 应用内部窗格拖动使用的 MIME 类型。 */
export const PANE_DRAG_TYPE = "application/x-tht-pane";

// WebView2 某些版本在 dragover 阶段不会暴露自定义 types，按 DataTransfer 对象追踪源拖动。
const trackedTransfers = new WeakSet<object>();

/** 记录一次 HTML5 窗格拖动，供终端文件拖放监听器识别并放行。 */
export function beginPaneHtmlDrag(
  dataTransfer: DataTransfer | null | undefined,
): void {
  if (dataTransfer && typeof dataTransfer === "object") {
    trackedTransfers.add(dataTransfer);
  }
}

/** 清理一次 HTML5 窗格拖动。 */
export function endPaneHtmlDrag(
  dataTransfer: DataTransfer | null | undefined,
): void {
  if (dataTransfer && typeof dataTransfer === "object") {
    trackedTransfers.delete(dataTransfer);
  }
}

/** 判断拖放是否来自应用内部窗格，而不是文件/文本等外部内容。 */
export function isInternalPaneDrag(
  dataTransfer: DataTransfer | null | undefined,
): boolean {
  if (!dataTransfer) return false;
  if (typeof dataTransfer === "object" && trackedTransfers.has(dataTransfer)) {
    return true;
  }

  try {
    if (Array.from(dataTransfer.types ?? []).includes(PANE_DRAG_TYPE)) {
      return true;
    }
  } catch {
    // 某些 WebView 的 types 访问会抛异常，继续尝试 getData。
  }

  try {
    return Boolean(dataTransfer.getData(PANE_DRAG_TYPE));
  } catch {
    return false;
  }
}
