import { describe, expect, it } from "vitest";
import type { Workspace } from "../api/types";
import { buildProjectRecord } from "./projects";

describe("项目编辑", () => {
  it("修改名称和默认供应商时保留旧独立配置", () => {
    const existing: Workspace = {
      id: "project-1",
      name: "旧名称",
      path: "D:\\AI\\old",
      agent: "claude",
      useGlobalConfig: false,
      config: {
        baseUrl: "https://legacy.example.com",
        apiKey: "legacy-key",
        model: "legacy-model",
      },
      sortOrder: 2,
      createdAt: "2026-07-10T12:00:00.000Z",
    };

    const updated = buildProjectRecord({
      existing,
      name: "新名称",
      path: existing.path,
      providerId: "codex-a",
      providers: [{ id: "codex-a", name: "Codex A", driver: "codex" }],
      sortOrder: 9,
      now: "2026-07-12T12:00:00.000Z",
    });

    expect(updated.useGlobalConfig).toBe(false);
    expect(updated.config).toEqual(existing.config);
    expect(updated.id).toBe(existing.id);
    expect(updated.sortOrder).toBe(existing.sortOrder);
    expect(updated.agent).toBe("codex");
    expect(updated.defaultProviderId).toBe("codex-a");
  });
});
