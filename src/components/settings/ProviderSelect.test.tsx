// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderSelect } from "./ProviderSelect";

afterEach(cleanup);

const providers = [
  { id: "a", name: "Claude A", driver: "claude" as const },
  { id: "b", name: "Claude B", driver: "claude" as const },
  { id: "c", name: "Codex A", driver: "codex" as const },
];

describe("ProviderSelect", () => {
  it("列出全部命名供应商并返回稳定 ID", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ProviderSelect
        providers={providers}
        value="a"
        onChange={onChange}
      />,
    );

    expect(screen.getByRole("option", { name: "Claude A" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Claude B" })).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("供应商"), "c");
    expect(onChange).toHaveBeenCalledWith("c");
  });

  it("会话选择器可以明确继承项目默认供应商", () => {
    render(
      <ProviderSelect
        providers={providers}
        value=""
        inheritLabel="跟随项目默认"
        onChange={() => undefined}
      />,
    );

    expect(screen.getByRole("option", { name: "跟随项目默认" })).toBeTruthy();
  });
});
