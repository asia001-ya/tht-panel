/**
 * 跨浏览器 / Tauri 的剪贴板适配层。
 *
 * 终端和原生对话框都通过这里处理粘贴，避免各组件分别猜测 Clipboard API
 * 是否可用。图片优先保存为临时文件；后端不可用时保留 data URL 作为文本降级。
 */
import { clipboardSaveImage } from "../api/commands";

export type ClipboardPayload =
  | { kind: "text"; text: string }
  | { kind: "file"; text: string; filePaths: string[] }
  | { kind: "image"; text: string; filePath?: string; dataUrl: string }
  | { kind: "none" };

interface ClipboardWithRead {
  read?: () => Promise<ClipboardItem[]>;
  readText?: () => Promise<string>;
  writeText?: (text: string) => Promise<void>;
}

interface PathLikeFile extends File {
  path?: string;
}

/** 将路径转换为可以直接粘贴到 PowerShell / shell 的参数。 */
export function formatClipboardPaths(paths: string[]): string {
  return paths
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => {
      if (!/[\s"']/u.test(path)) return path;
      return `"${path.replace(/"/gu, '\\"')}"`;
    })
    .join(" ");
}

/** 尝试从 file:// URI 还原本地路径。不能还原时返回原值。 */
function fileUriToPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith("file://")) return trimmed;
  try {
    const url = new URL(trimmed);
    let path = decodeURIComponent(url.pathname);
    // Windows file URI 通常形如 file:///C:/work；去掉多余的首斜杠。
    if (/^\/[A-Za-z]:/u.test(path)) path = path.slice(1);
    if (url.hostname && url.hostname !== "localhost") {
      path = `\\\\${url.hostname}${path.replace(/\//gu, "\\")}`;
    } else if (/^[A-Za-z]:/u.test(path)) {
      path = path.replace(/\//gu, "\\");
    }
    return path;
  } catch {
    return trimmed;
  }
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const normalized = fileUriToPath(path);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/** 从拖放 / paste 事件中提取 Tauri 注入的绝对路径和标准 URI 列表。 */
export function extractClipboardFilePaths(data?: DataTransfer | null): string[] {
  if (!data) return [];

  const paths: string[] = [];
  const collectFile = (file: File): void => {
    const candidate = (file as PathLikeFile).path;
    if (candidate) paths.push(candidate);
  };

  if (data.files) {
    for (const file of Array.from(data.files)) collectFile(file);
  }
  if (data.items) {
    for (const item of Array.from(data.items)) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file) collectFile(file);
    }
  }

  for (const type of ["text/uri-list", "text/x-moz-url"]) {
    const value = data.getData(type);
    if (!value) continue;
    for (const line of value.split(/\r?\n/u)) {
      if (!line || line.startsWith("#")) continue;
      // text/x-moz-url 可能带有第二行显示标题，只保留 URI。
      paths.push(line.split("\n", 1)[0]);
    }
  }

  return uniquePaths(paths);
}

export function clipboardHasImage(data?: DataTransfer | null): boolean {
  if (!data?.items) return false;
  return Array.from(data.items).some(
    (item) => item.kind === "file" && item.type.toLowerCase().startsWith("image/"),
  );
}

function imageFileFromDataTransfer(data?: DataTransfer | null): File | null {
  if (!data?.items) return null;
  for (const item of Array.from(data.items)) {
    if (item.kind !== "file" || !item.type.toLowerCase().startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return null;
}

function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("无法读取剪贴板图片"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("无法读取剪贴板图片"));
    reader.readAsDataURL(file);
  });
}

/** 把图片交给 Rust 保存，浏览器环境或权限不足时返回 null。 */
export async function saveClipboardImage(
  dataUrl: string,
  fileName?: string,
): Promise<string | null> {
  try {
    const path = await clipboardSaveImage(dataUrl, fileName);
    return typeof path === "string" && path.length > 0 ? path : null;
  } catch {
    return null;
  }
}

export async function copyClipboardText(text: string): Promise<void> {
  if (!text) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // WebView 的异步剪贴板可能因焦点 / 权限失败，继续使用同步回退。
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("剪贴板不可用");
    }
  } finally {
    textarea.remove();
  }
}

export async function readClipboardText(textHint?: string | null): Promise<string> {
  if (typeof textHint === "string" && textHint.length > 0) return textHint;
  try {
    if (navigator.clipboard?.readText) return await navigator.clipboard.readText();
  } catch {
    // 读取系统剪贴板需要用户手势；失败时由调用方显示空状态。
  }
  return "";
}

async function readClipboardItemPayload(): Promise<ClipboardPayload> {
  const clipboard = navigator.clipboard as ClipboardWithRead | undefined;
  if (!clipboard?.read) return { kind: "none" };

  let items: ClipboardItem[];
  try {
    items = await clipboard.read();
  } catch {
    return { kind: "none" };
  }

  for (const item of items) {
    const imageType = item.types.find((type) => type.toLowerCase().startsWith("image/"));
    if (imageType) {
      try {
        const blob = await item.getType(imageType);
        const dataUrl = await fileToDataUrl(blob);
        const filePath = await saveClipboardImage(dataUrl, "clipboard-image");
        return { kind: "image", text: filePath ?? dataUrl, filePath: filePath ?? undefined, dataUrl };
      } catch {
        // 继续尝试读取同一剪贴板中的文本。
      }
    }
  }

  for (const item of items) {
    if (!item.types.includes("text/plain")) continue;
    try {
      const text = await (await item.getType("text/plain")).text();
      if (text) return { kind: "text", text };
    } catch {
      // 忽略单个 ClipboardItem 的读取失败。
    }
  }
  return { kind: "none" };
}

/** 读取 Tauri 注入的文件剪贴板；失败时返回空数组，不影响普通文本粘贴。 */
export async function readClipboardFilePaths(): Promise<string[]> {
  try {
    // WebView 可能提供 text/uri-list，但不会把路径挂到 File.path 上。
    const text = await readClipboardText();
    if (!text) return [];
    const paths = text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.toLowerCase().startsWith("file://"))
      .map(fileUriToPath);
    return uniquePaths(paths);
  } catch {
    return [];
  }
}

/** 解析事件或系统剪贴板，优先级为文件路径 > 图片 > 文本。 */
export async function resolveClipboardPayload(
  data?: DataTransfer | null,
): Promise<ClipboardPayload> {
  const filePaths = extractClipboardFilePaths(data);
  if (filePaths.length > 0) {
    return { kind: "file", text: formatClipboardPaths(filePaths), filePaths };
  }

  const imageFile = imageFileFromDataTransfer(data);
  if (imageFile) {
    try {
      const dataUrl = await fileToDataUrl(imageFile);
      const filePath = await saveClipboardImage(dataUrl, imageFile.name || "clipboard-image");
      return { kind: "image", text: filePath ?? dataUrl, filePath: filePath ?? undefined, dataUrl };
    } catch {
      // 图片读取失败时仍允许继续读取普通文本。
    }
  }

  if (!data) {
    const filePaths = await readClipboardFilePaths();
    if (filePaths.length > 0) {
      return { kind: "file", text: formatClipboardPaths(filePaths), filePaths };
    }
  }

  const text = await readClipboardText(data?.getData("text/plain"));
  if (text) return { kind: "text", text };

  // 右键菜单等路径没有 ClipboardEvent.dataTransfer，只能请求异步读取。
  if (!data || clipboardHasImage(data)) return readClipboardItemPayload();
  return { kind: "none" };
}
