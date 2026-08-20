// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clipboardSaveImage } from "../api/commands";
import {
  extractClipboardFilePaths,
  formatClipboardPaths,
  resolveClipboardPayload,
} from "./clipboard";

vi.mock("../api/commands", () => ({
  clipboardSaveImage: vi.fn(),
}));

function dataTransfer(args: {
  text?: string;
  uriList?: string;
  files?: File[];
}): DataTransfer {
  const files = args.files ?? [];
  return {
    files,
    items: files.map((file) => ({
      kind: "file",
      type: file.type,
      getAsFile: () => file,
    })),
    getData: (type: string) => {
      if (type === "text/plain") return args.text ?? "";
      if (type === "text/uri-list") return args.uriList ?? "";
      return "";
    },
  } as unknown as DataTransfer;
}

describe("clipboard helper", () => {
  beforeEach(() => {
    vi.mocked(clipboardSaveImage).mockReset();
  });

  it("为包含空格的终端路径添加引号", () => {
    expect(formatClipboardPaths(["D:\\work\\a.txt", "D:\\my work\\b.png"])).toBe(
      "D:\\work\\a.txt \"D:\\my work\\b.png\"",
    );
  });

  it("从 URI 列表提取并规范化 Windows 路径", () => {
    const paths = extractClipboardFilePaths(dataTransfer({
      uriList: "# copied files\nfile:///D:/my%20work/a.txt\nfile:///D:/b.txt",
    }));
    expect(paths).toEqual(["D:\\my work\\a.txt", "D:\\b.txt"]);
  });

  it("优先返回拖放文件路径", async () => {
    const file = new File(["hello"], "hello.txt", { type: "text/plain" }) as File & {
      path?: string;
    };
    file.path = "D:\\my work\\hello.txt";

    await expect(resolveClipboardPayload(dataTransfer({ files: [file] }))).resolves.toEqual({
      kind: "file",
      text: "\"D:\\my work\\hello.txt\"",
      filePaths: ["D:\\my work\\hello.txt"],
    });
  });

  it("图片保存失败时回退为 data URL", async () => {
    vi.mocked(clipboardSaveImage).mockRejectedValue(new Error("not in Tauri"));
    const image = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", {
      type: "image/png",
    });

    const payload = await resolveClipboardPayload(dataTransfer({ files: [image] }));
    expect(payload.kind).toBe("image");
    if (payload.kind === "image") {
      expect(payload.filePath).toBeUndefined();
      expect(payload.text).toMatch(/^data:image\/png;base64,/u);
    }
  });

  it("读取 paste 事件中的普通文本", async () => {
    await expect(resolveClipboardPayload(dataTransfer({ text: "hello\nworld" }))).resolves.toEqual({
      kind: "text",
      text: "hello\nworld",
    });
  });
});
