// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";

const terms: Terminal[] = [];
let createTerm: typeof import("./xtermManager").createTerm;
let unregisterTerm: typeof import("./xtermManager").unregisterTerm;
let originalGetContext: PropertyDescriptor | undefined;

beforeAll(async () => {
  originalGetContext = Object.getOwnPropertyDescriptor(
    HTMLCanvasElement.prototype,
    "getContext",
  );
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => null,
  });
  ({ createTerm, unregisterTerm } = await import("./xtermManager"));
});

afterAll(() => {
  if (originalGetContext) {
    Object.defineProperty(
      HTMLCanvasElement.prototype,
      "getContext",
      originalGetContext,
    );
  } else {
    Reflect.deleteProperty(HTMLCanvasElement.prototype, "getContext");
  }
});

/**
 * 创建测试终端并登记到清理列表。
 * @returns 使用默认浅色配置的 xterm 实例。
 */
function createTestTerm(): Terminal {
  const { term } = createTerm({
    fontSize: 13,
    scrollbackLines: 100,
    theme: "light",
  });
  terms.push(term);
  return term;
}

/**
 * 写入控制序列并等待 xterm 解析完成。
 * @param term 目标终端。
 * @param data 待解析的终端数据。
 * @returns 解析完成时解决的 Promise。
 */
function writeParsed(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => {
    const disposable = term.onWriteParsed(() => {
      disposable.dispose();
      resolve();
    });
    term.write(data);
  });
}

afterEach(() => {
  for (const term of terms.splice(0)) {
    unregisterTerm(term);
    term.dispose();
  }
});

describe("xterm 稳定光标", () => {
  it("把闪烁条形光标请求转换为稳定条形光标", async () => {
    const term = createTestTerm();

    await writeParsed(term, "\u001b[5 q");

    expect(term.options.cursorBlink).toBe(false);
    expect(term.options.cursorStyle).toBe("bar");
  });

  it("把闪烁下划线光标请求转换为稳定下划线光标", async () => {
    const term = createTestTerm();

    await writeParsed(term, "\u001b[3 q");

    expect(term.options.cursorBlink).toBe(false);
    expect(term.options.cursorStyle).toBe("underline");
  });
});
