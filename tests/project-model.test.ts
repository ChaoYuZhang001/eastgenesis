// 项目模型：校验规整、说明叠加（任务 > 目标 > 项目 > 全局系统提示）、路由偏好继承（任务 > 目标 > 项目 > 全局默认）
import {
  INSTRUCTIONS_HEADER,
  MAX_CONTEXT_FOLDERS,
  PROJECT_ID,
  newProjectId,
  normalizeFolders,
  normalizeProject,
  preferenceSource,
  resolveInstructions,
  resolveRoutingPreference,
} from "@/decision/project";

const err = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e as { code: string; message: string };
  }
  throw new Error("没有抛错");
};

describe("normalizeProject", () => {
  it("规整：名称和说明折叠空白；指令统一换行、去控制字符、最多一个空行；偏好为空时不覆盖", () => {
    const v = normalizeProject({
      name: "  季度  报告 ",
      description: "第一行\n第二行",
      instructions: "先写结论。  \r\n\r\n\r\n\r\n用表格\u0007。",
      // 表单下拉框的「沿用上级」是空串；类型上不允许，运行时按「不覆盖」处理
      routing_preference: "" as never,
    });
    expect(v).toEqual({ name: "季度 报告", description: "第一行 第二行", instructions: "先写结论。\n\n用表格。", context_folders: [], routing_preference: null });
    expect(normalizeProject({ name: "A", routing_preference: "economy" }).routing_preference).toBe("economy");
  });

  it("拒绝：空名称、超长、无效偏好、像密钥的内容；错误信息不回显内容", () => {
    expect(err(() => normalizeProject({ name: "   " }))).toMatchObject({ code: "invalid_project", message: expect.stringMatching(/名称/) });
    expect(err(() => normalizeProject({ name: "x".repeat(61) })).code).toBe("invalid_project");
    expect(err(() => normalizeProject({ name: "A", instructions: "x".repeat(4001) })).message).toMatch(/指令/);
    expect(err(() => normalizeProject({ name: "A", routing_preference: "cheap" as never })).message).toMatch(/省钱、平衡或最强/);
    const secret = err(() => normalizeProject({ name: "A", instructions: "调用时用 api_key=abcd1234efgh5678" }));
    expect(secret.message).toMatch(/密钥/);
    expect(secret.message).not.toContain("abcd1234");
    // 只提到 token 这个词不算
    expect(normalizeProject({ name: "A", instructions: "token 从环境变量读" }).instructions).toBe("token 从环境变量读");
  });

  it("上下文文件夹：绝对路径、合并分隔符、去掉末尾分隔符后去重", () => {
    expect(normalizeFolders(["/Users/a/docs/", "/Users/a//docs", " ~/work ", "C:\\proj\\", "C:/proj2", ""])).toEqual(["/Users/a/docs", "~/work", "C:\\proj", "C:/proj2"]);
    expect(normalizeFolders(undefined)).toEqual([]);
  });

  it("上下文文件夹：拒绝相对路径、整个磁盘或家目录、..、过多、不是列表", () => {
    expect(err(() => normalizeFolders(["docs/"])).message).toMatch(/绝对路径/);
    for (const root of ["/", "~", "~/", "//", "C:\\", "C:/"]) expect(err(() => normalizeFolders([root])).message).toMatch(/整个磁盘或整个家目录/);
    expect(err(() => normalizeFolders(["/Users/a/../b"])).message).toMatch(/\.\./);
    expect(err(() => normalizeFolders(Array.from({ length: MAX_CONTEXT_FOLDERS + 1 }, (_, i) => `/d/${i}`))).message).toMatch(/最多/);
    expect(err(() => normalizeFolders("/Users/a")).message).toMatch(/列表/);
  });

  it("新 ID 符合格式", () => {
    expect(newProjectId()).toMatch(PROJECT_ID);
  });
});

describe("resolveInstructions：任务 > 目标 > 项目 > 全局系统提示", () => {
  it("全部为空返回空串；空白当作没写", () => {
    expect(resolveInstructions(null, undefined, { instructions: "  \n " })).toBe("");
  });

  it("按项目 → 目标 → 任务排列，写明后写的为准；空层跳过", () => {
    const s = resolveInstructions({ instructions: "这次用英文回答" }, { instructions: "" }, { instructions: "用中文回答\n结论放最前" });
    expect(s).toBe(`${INSTRUCTIONS_HEADER}\n\n【项目】\n用中文回答\n结论放最前\n\n【任务】\n这次用英文回答`);
    expect(s.indexOf("【项目】")).toBeLessThan(s.indexOf("【任务】"));
    expect(INSTRUCTIONS_HEADER).toMatch(/以后写的为准/);
    expect(INSTRUCTIONS_HEADER).toMatch(/同一层里，后出现的覆盖先出现的/);
  });

  it("三层都有时顺序固定", () => {
    const s = resolveInstructions({ instructions: "T" }, { instructions: "G" }, { instructions: "P" });
    expect(s.split("\n\n").slice(1)).toEqual(["【项目】\nP", "【目标】\nG", "【任务】\nT"]);
  });
});

describe("resolveRoutingPreference：任务 > 目标 > 项目 > 全局默认", () => {
  it("取第一个设了的层", () => {
    expect(resolveRoutingPreference({ routing_preference: "best" }, { routing_preference: "economy" }, { routing_preference: "balanced" })).toBe("best");
    expect(resolveRoutingPreference({}, { routing_preference: "economy" }, { routing_preference: "best" })).toBe("economy");
    expect(resolveRoutingPreference(null, { routing_preference: null }, { routing_preference: "best" })).toBe("best");
  });

  it("都没设时用全局默认；全局也没传时是 balanced", () => {
    expect(resolveRoutingPreference(null, null, null)).toBe("balanced");
    expect(resolveRoutingPreference(null, null, { routing_preference: null }, "economy")).toBe("economy");
  });

  it("无效值（例如旧数据里的 cheap）当作没设，继续往下找；并写明来自哪一层", () => {
    expect(resolveRoutingPreference({ routing_preference: "cheap" }, null, { routing_preference: "best" })).toBe("best");
    expect(preferenceSource({ routing_preference: "cheap" }, null, { routing_preference: "best" })).toEqual({ preference: "best", source: "project" });
    expect(preferenceSource(null, null, null, "economy")).toEqual({ preference: "economy", source: "global" });
    expect(preferenceSource(null, null, null, "bogus" as never)).toEqual({ preference: "balanced", source: "global" });
  });
});
