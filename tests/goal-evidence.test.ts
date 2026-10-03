// 目标完成校验的规则部分：实据规整、矛盾、没有实据、明确满足，以及 Jev 概率到结论的换算
import {
  CLAIM_ONLY_REASON,
  MAX_COMMANDS,
  MAX_OUTPUT_CHARS,
  NO_RECORD_REASON,
  evidenceRecord,
  expectedOutputs,
  isTestCommand,
  judgeByRules,
  mergeEvidence,
  namedOutputs,
  sanitizeEvidence,
  testPassed,
  verdictFromProbability,
  type Evidence,
} from "@/decision/evidence";

const ev = (e: Partial<Evidence>): Evidence => ({ tool_calls: [], file_changes: [], command_outputs: [], ...e });
const cmd = (command: string, exit_code: number | null, output = "") => ({ command, exit_code, output });

describe("sanitizeEvidence", () => {
  it("脱敏、去控制字符、长输出保留末尾；无效值按默认处理；再规整一次不变", () => {
    const raw = {
      tool_calls: [{ tool: "http", ok: true, target: "https://x.test", summary: "Authorization: Bearer abcdefghijklmnop" }, { tool: "", ok: "yes" }],
      file_changes: [{ path: "/a/b.md", action: "bogus", to: "/c" }, { path: "", action: "created" }],
      command_outputs: [{ command: "pnpm test", exit_code: 1.5, output: `${"x".repeat(5000)}\u0007\nTests 3 passed` }],
      claim: "  已完成  ",
    };
    const e = sanitizeEvidence(raw);
    expect(e.tool_calls[0].summary).not.toContain("abcdefghijklmnop");
    expect(e.tool_calls[1]).toEqual({ tool: "unknown", read_only: false, ok: false });
    expect(e.file_changes).toEqual([{ path: "/a/b.md", action: "modified" }]);
    const out = e.command_outputs[0];
    expect(out.exit_code).toBeNull();
    expect(out.output.length).toBe(MAX_OUTPUT_CHARS);
    expect(out.output.startsWith("…")).toBe(true);
    expect(out.output.endsWith("Tests 3 passed")).toBe(true);
    expect(out.output).not.toContain("\u0007");
    expect(e.claim).toBe("已完成");
    expect(sanitizeEvidence(e)).toEqual(e);
    expect(sanitizeEvidence(null)).toEqual(ev({}));
  });

  it("保存时每类只留最近的若干条；合并判断时不截条数", () => {
    const many = { command_outputs: Array.from({ length: MAX_COMMANDS + 5 }, (_, i) => cmd(`echo ${i}`, 0)) };
    expect(sanitizeEvidence(many).command_outputs.map((c) => c.command)[0]).toBe("echo 5");
    expect(sanitizeEvidence(many, { cap: false }).command_outputs).toHaveLength(MAX_COMMANDS + 5);
  });

  it("mergeEvidence 按先后拼接，claim 取最后一个有的", () => {
    const m = mergeEvidence([ev({ file_changes: [{ path: "/a", action: "created" }], claim: "第一轮" }), null, ev({ command_outputs: [cmd("ls", 0)] })]);
    expect(m.file_changes).toHaveLength(1);
    expect(m.command_outputs).toHaveLength(1);
    expect(m.claim).toBe("第一轮");
  });
});

describe("judgeByRules：矛盾", () => {
  it("测试命令最后一次没通过 → not_done；后来同一条命令通过了就不算矛盾", () => {
    const failing = judgeByRules("修好登录 bug", ev({ command_outputs: [cmd("pnpm test", 1, "Tests 1 failed | 3 passed")], claim: "修好了" }));
    expect(failing).toMatchObject({ verdict: "not_done", by: "rules" });
    expect(failing?.reason).toMatch(/pnpm test/);
    const fixed = judgeByRules("让测试通过", ev({ command_outputs: [cmd("pnpm test", 1, "1 failed"), cmd("pnpm  test", 0, "Tests 4 passed")] }));
    expect(fixed?.verdict).toBe("done");
  });

  it("退出码是 0 但输出写了失败（管道吞掉退出码）也算没通过；没正常结束的也算", () => {
    expect(judgeByRules("让测试通过", ev({ command_outputs: [cmd("pnpm test | tail -5", 0, "Tests  2 failed | 10 passed")] }))?.verdict).toBe("not_done");
    expect(judgeByRules("让测试通过", ev({ command_outputs: [cmd("cargo test", null, "running 3 tests")] }))?.reason).toMatch(/没有正常结束/);
  });
});
describe("judgeByRules：没有实据", () => {
  it("只有自述 → uncertain「AI 声称完成，但无实据」；只读工具调用不算实据", () => {
    const r = judgeByRules("总结这份文档", ev({ tool_calls: [{ tool: "read_file", read_only: true, ok: true, target: "/a.pdf" }], claim: "已经总结好了" }));
    expect(r).toEqual({ verdict: "uncertain", reason: CLAIM_ONLY_REASON, by: "rules" });
    expect(CLAIM_ONLY_REASON).toBe("AI 声称完成，但无实据");
  });

  it("什么都没有 → not_done；失败的写入不算实据", () => {
    expect(judgeByRules("整理文件夹", ev({}))).toEqual({ verdict: "not_done", reason: NO_RECORD_REASON, by: "rules" });
    expect(judgeByRules("整理文件夹", ev({ tool_calls: [{ tool: "move_file", read_only: false, ok: false }] }))?.verdict).toBe("not_done");
  });
});

describe("judgeByRules：明确满足", () => {
  it("点名的文件都产出了 → done；缺一个、产出后又删掉、只读过都不算", () => {
    const goal = "读 data.csv，生成 report.md 和 chart.png";
    expect(namedOutputs(goal)).toEqual(["report.md", "chart.png"]);
    const made = [
      { path: "/Users/a/out/report.md", action: "created" as const },
      { path: "/Users/a/out/chart.png", action: "modified" as const },
    ];
    expect(judgeByRules(goal, ev({ file_changes: made }))).toMatchObject({ verdict: "done", by: "rules" });
    expect(judgeByRules(goal, ev({ file_changes: made.slice(0, 1) }))).toBeNull();
    expect(judgeByRules(goal, ev({ file_changes: [...made, { path: "/Users/a/out/chart.png", action: "deleted" }] }))).toBeNull();
    // 只是文件名结尾相同不算
    expect(judgeByRules(goal, ev({ file_changes: [{ path: "/a/xreport.md", action: "created" }, made[1]] }))).toBeNull();
  });

  it("改名、移动以新路径为准", () => {
    const goal = "把 draft.md 改名为 final.md";
    expect(namedOutputs(goal)).toEqual(["final.md"]);
    expect(judgeByRules(goal, ev({ file_changes: [{ path: "/w/draft.md", action: "moved", to: "/w/final.md" }] }))?.verdict).toBe("done");
  });

  it("测试类目标：测试通过 → done；没跑测试不算；「补测试」还要有文件改动", () => {
    expect(judgeByRules("修好解析器，让测试通过", ev({ command_outputs: [cmd("cargo test -p eg-core", 0, "test result: ok. 74 passed; 0 failed")] }))?.verdict).toBe("done");
    expect(judgeByRules("让测试通过", ev({ command_outputs: [cmd("ls", 0, "src")] }))).toBeNull();
    const ran = { command_outputs: [cmd("pnpm vitest run", 0, "Tests 12 passed")] };
    expect(judgeByRules("给 utils 补单元测试", ev(ran))).toBeNull();
    expect(judgeByRules("给 utils 补单元测试", ev({ ...ran, file_changes: [{ path: "/p/tests/utils.test.ts", action: "created" }] }))?.verdict).toBe("done");
  });

  it("期望输出：引号里的文本出现在成功命令的输出里 → done；失败命令的输出不算", () => {
    const goal = '写个 hello.py，运行后应该输出 "Hello, EastGenesis"';
    expect(expectedOutputs(goal)).toEqual(["Hello, EastGenesis"]);
    expect(namedOutputs(goal)).toEqual(["hello.py"]);
    const file = { path: "/w/hello.py", action: "created" as const };
    expect(judgeByRules(goal, ev({ file_changes: [file], command_outputs: [cmd("python hello.py", 0, "Hello,  EastGenesis\n")] }))?.verdict).toBe("done");
    expect(judgeByRules(goal, ev({ file_changes: [file], command_outputs: [cmd("python hello.py", 1, "Hello, EastGenesis")] }))).toBeNull();
  });

  it("多个条件要全部满足：测试通过但文件没生成时规则不下结论", () => {
    const goal = "修好解析器让测试通过，然后生成 CHANGELOG.md";
    const tests = { command_outputs: [cmd("pnpm test", 0, "Tests 4 passed")] };
    expect(judgeByRules(goal, ev(tests))).toBeNull();
    expect(judgeByRules(goal, ev({ ...tests, file_changes: [{ path: "/p/changelog.md", action: "created" }] }))?.verdict).toBe("done");
  });

  it("有实据但没有能核对的条件 → null（交给 Jev 或你确认）", () => {
    expect(judgeByRules("把下载文件夹按类型整理好", ev({ file_changes: [{ path: "/d/a.pdf", action: "moved", to: "/d/PDF/a.pdf" }] }))).toBeNull();
  });
});

describe("从目标里找产出文件", () => {
  it("引号里的文件名可以有空格和中文；动词后面的路径；输入文件和停用词后面的不算", () => {
    expect(namedOutputs("根据 notes.txt 写一份「周报 第3周.docx」")).toEqual(["周报 第3周.docx"]);
    expect(namedOutputs("把结果保存为 ~/Desktop/sales-2026.csv 并发邮件给我")).toEqual(["~/Desktop/sales-2026.csv"]);
    expect(namedOutputs("生成周报.docx")).toEqual(["周报.docx"]);
    expect(namedOutputs("用 Node.js 18 读取 v1.2 的配置，写入 config.json")).toEqual(["config.json"]);
    expect(namedOutputs("generate report.md from data.csv")).toEqual(["report.md"]);
    expect(namedOutputs("解释一下 3.5 版本和 v1.2.3 的区别")).toEqual([]);
  });
});
describe("测试命令和测试结果", () => {
  it("识别常见测试命令；装依赖、看配置文件、echo 不算", () => {
    for (const c of ["pnpm test", "pnpm -s test", "npm run test:unit", "pnpm --filter web test", "cargo test --locked -p eg-core", "go test ./...", "python -m pytest -q", "npx vitest run", "cd app && yarn test", "make check", "./gradlew test", "python manage.py test"])
      expect(isTestCommand(cmd(c, 0)), c).toBe(true);
    for (const c of ["echo test", "vim vitest.config.ts", "npm view test-pkg", "pnpm add -D vitest", "cat README.md", "ls tests", "git commit -m test"])
      expect(isTestCommand(cmd(c, 0)), c).toBe(false);
  });

  it("通过：退出码 0 且输出没有失败汇总；「0 failed」不算失败", () => {
    expect(testPassed(cmd("cargo test", 0, "test result: ok. 74 passed; 0 failed; 0 ignored"))).toBe(true);
    expect(testPassed(cmd("pnpm test", 0, " Test Files  52 passed (52)\n      Tests  464 passed (464)"))).toBe(true);
    for (const out of ["Tests: 1 failed, 3 passed", "FAILED tests/test_a.py::test_x", " FAIL  src/a.test.ts > parses", "--- FAIL: TestParse (0.00s)", "2 failing", "Tests run: 5, Failures: 1"])
      expect(testPassed(cmd("t", 0, out)), out).toBe(false);
    expect(testPassed(cmd("pnpm test", 1, "Tests 4 passed"))).toBe(false);
  });
});

describe("Jev：概率到结论、发送的 state", () => {
  it("确定程度 |2p − 1| 达到 0.6 才下结论（含边界），否则 uncertain；无效值 uncertain", () => {
    expect(verdictFromProbability(0.95)).toMatchObject({ verdict: "done", by: "jev" });
    expect(verdictFromProbability(0.8).verdict).toBe("done");
    expect(verdictFromProbability(0.2).verdict).toBe("not_done");
    expect(verdictFromProbability(0.79).verdict).toBe("uncertain");
    expect(verdictFromProbability(0.5)).toMatchObject({ verdict: "uncertain", confidence: 0 });
    expect(verdictFromProbability(0.21).verdict).toBe("uncertain");
    expect(verdictFromProbability(Number.NaN).verdict).toBe("uncertain");
    expect(verdictFromProbability(0.9, 0.9).verdict).toBe("uncertain");
  });

  it("state 只有目标和执行记录，不含模型自述；脱敏；整体不超过 Jev state 上限", () => {
    const s = evidenceRecord("生成 a.md", ev({ file_changes: [{ path: "/w/a.md", action: "created" }], command_outputs: [cmd("cat a.md", 0, "api_key=abcd1234efgh5678")], claim: "我已经全部完成" }));
    expect(s.goal).toBe("生成 a.md");
    expect(s.record).toMatch(/created \/w\/a\.md/);
    expect(s.record).not.toContain("我已经全部完成");
    expect(s.record).not.toContain("abcd1234efgh5678");
    const big = evidenceRecord("x", ev({ command_outputs: Array.from({ length: 200 }, (_, i) => cmd(`run ${i}`, 0, "y".repeat(1000))) }));
    expect(JSON.stringify(big).length).toBeLessThan(20_000);
    expect(big.record).toMatch(/earlier omitted/);
    expect(big.record).toContain("run 199");
  });
});
