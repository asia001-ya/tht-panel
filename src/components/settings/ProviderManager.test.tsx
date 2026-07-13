// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderProfile } from "../../api/types";
import { ProviderManager } from "./ProviderManager";

const initial: ProviderProfile[] = [
  {
    id: "claude-a",
    name: "Claude A",
    driver: "claude",
    baseUrl: "https://a.example.com",
  },
  {
    id: "claude-b",
    name: "Claude B",
    driver: "claude",
    baseUrl: "https://b.example.com",
  },
];

afterEach(cleanup);

describe("ProviderManager", () => {
  it("同时展示同一驱动的多套供应商", () => {
    render(<ProviderManager providers={initial} onChange={() => undefined} />);

    expect(screen.getByText("Claude A")).toBeTruthy();
    expect(screen.getByText("Claude B")).toBeTruthy();
    expect(screen.getAllByText("Claude")).toHaveLength(2);
  });

  it("新增供应商时提交连接配置和逐行附加参数", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ProviderManager providers={initial} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "添加供应商" }));
    await user.type(screen.getByLabelText("供应商名称"), "Codex A");
    await user.selectOptions(screen.getByLabelText("驱动"), "codex");
    await user.type(screen.getByLabelText("API 地址"), "https://codex.example.com");
    await user.type(screen.getByLabelText("API Key"), "secret");
    await user.type(screen.getByLabelText("模型"), "gpt-5");
    await user.type(
      screen.getByLabelText("附加参数（每行一个）"),
      "  --verbose  {enter}{enter} --profile dev ",
    );
    await user.click(screen.getByRole("button", { name: "保存供应商" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual([
      ...initial,
      expect.objectContaining({
        name: "Codex A",
        driver: "codex",
        baseUrl: "https://codex.example.com",
        apiKey: "secret",
        model: "gpt-5",
        extraArgs: ["--verbose", "--profile dev"],
      }),
    ]);
  });

  it("编辑供应商时逐行回填并规范化附加参数", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const withArgs: ProviderProfile[] = [
      { ...initial[0], extraArgs: ["--old", "--trace"] },
    ];
    render(<ProviderManager providers={withArgs} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "编辑 Claude A" }));
    const textarea = screen.getByLabelText(
      "附加参数（每行一个）",
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe("--old\n--trace");

    await user.clear(textarea);
    await user.type(textarea, " --new {enter}{enter}--safe ");
    await user.click(screen.getByRole("button", { name: "保存供应商" }));

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ extraArgs: ["--new", "--safe"] }),
    ]);
  });

  it("清空附加参数时不保留 extraArgs 字段", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const withArgs: ProviderProfile[] = [
      { ...initial[0], extraArgs: ["--old"] },
    ];
    render(<ProviderManager providers={withArgs} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "编辑 Claude A" }));
    await user.clear(screen.getByLabelText("附加参数（每行一个）"));
    await user.click(screen.getByRole("button", { name: "保存供应商" }));

    const saved = onChange.mock.calls[0][0][0] as ProviderProfile;
    expect(Object.prototype.hasOwnProperty.call(saved, "extraArgs")).toBe(false);
  });
});
