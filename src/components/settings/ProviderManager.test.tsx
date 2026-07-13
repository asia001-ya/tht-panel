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

  it("新增供应商时提交名称、驱动、地址、密钥和模型", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ProviderManager providers={initial} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "添加供应商" }));
    await user.type(screen.getByLabelText("供应商名称"), "Codex A");
    await user.selectOptions(screen.getByLabelText("驱动"), "codex");
    await user.type(screen.getByLabelText("API 地址"), "https://codex.example.com");
    await user.type(screen.getByLabelText("API Key"), "secret");
    await user.type(screen.getByLabelText("模型"), "gpt-5");
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
      }),
    ]);
  });
});
