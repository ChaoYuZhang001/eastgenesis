#!/usr/bin/env node
// Linux / Windows 原生 Tauri WebView 的最小 DOM smoke。
// 需要 tauri-driver 以及对应平台的 WebKitWebDriver / msedgedriver。
// 默认不提交任务；加 --stream 时使用只监听回环地址的 QA fixture，验证真实
// WebView 的任务提交和 SSE 渲染。不读取 Key、不访问真实 Provider。

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const valueOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const stream = args.includes("--stream");
const scenario = valueOf("--scenario") ?? (stream ? "slow-first-token" : null);
const streamScenarios = new Set(["staged", "slow-first-token", "truncated", "idle-cancel"]);
const fixtureScenario = scenario === "idle-cancel" ? "idle" : scenario;

if (scenario && !streamScenarios.has(scenario)) {
  throw new Error(`--scenario 必须是：${[...streamScenarios].join(", ")}`);
}
if (scenario && !stream) {
  throw new Error("--scenario 只能与 --stream 一起使用");
}

if (process.platform === "darwin") {
  throw new Error("desktop:webdriver:smoke requires Linux or Windows; tauri-driver does not support macOS");
}
if (process.platform !== "linux" && process.platform !== "win32") {
  throw new Error(`desktop:webdriver:smoke does not support ${process.platform}`);
}

const app = resolve(valueOf("--app") ?? process.env.EG_DESKTOP_APP ?? (process.platform === "win32" ? "target/release/eastgenesis-desktop.exe" : "target/release/eastgenesis-desktop"));
const port = Number(valueOf("--port") ?? process.env.EG_WEBDRIVER_PORT ?? 4444);
const nativePort = Number(valueOf("--native-port") ?? process.env.EG_NATIVE_WEBDRIVER_PORT ?? 4445);
const base = `http://127.0.0.1:${port}`;

await access(app);

let fixture = null;
let fixtureBase = null;
let fixtureOutput = "";
if (stream) {
  const fixturePort = Number(valueOf("--fixture-port") ?? process.env.EG_FIXTURE_PORT ?? 17000 + (process.pid % 1000));
  fixtureBase = `http://127.0.0.1:${fixturePort}/${fixtureScenario}/v1`;
  fixture = spawn(process.execPath, [resolve("tools/desktop-stream-fixture.mjs")], {
    env: { ...process.env, EG_FIXTURE_PORT: String(fixturePort), EG_FIXTURE_CHUNK_DELAY_MS: "300" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  fixture.stdout.setEncoding("utf8");
  fixture.stderr.setEncoding("utf8");
  fixture.stdout.on("data", (chunk) => { fixtureOutput += chunk; });
  fixture.stderr.on("data", (chunk) => { fixtureOutput += chunk; });
  const fixtureDeadline = Date.now() + 10_000;
  while (Date.now() < fixtureDeadline) {
    if (fixture.exitCode !== null) throw new Error(`stream fixture exited with ${fixture.exitCode}`);
    try {
      const response = await fetch(`${fixtureBase}/models`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) break;
    } catch {
      // The fixture may need a short time to bind its port.
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
  if (Date.now() >= fixtureDeadline) throw new Error(`stream fixture did not become ready${fixtureOutput ? ` (${fixtureOutput.trim().slice(0, 160)})` : ""}`);
}

const driver = spawn("tauri-driver", [`--port=${port}`, `--native-port=${nativePort}`], {
  env: stream
    ? {
        ...process.env,
        EASTGENESIS_QA_PROVIDER_BASE_URL: fixtureBase,
        EASTGENESIS_QA_PROVIDER_MODEL: "fixture-model",
        EASTGENESIS_QA_PROVIDER_PROTOCOL: "openai",
      }
    : process.env,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let driverOutput = "";
driver.stdout.setEncoding("utf8");
driver.stderr.setEncoding("utf8");
driver.stdout.on("data", (chunk) => { driverOutput += chunk; });
driver.stderr.on("data", (chunk) => { driverOutput += chunk; });

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const request = async (method, path, body) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`WebDriver returned non-JSON for ${method} ${path}`);
  }
  if (!response.ok) throw new Error(`WebDriver ${response.status} for ${method} ${path}`);
  const value = json?.value ?? json;
  if (value?.error) throw new Error(`WebDriver ${value.error}: ${value.message ?? "unknown error"}`);
  return value;
};

const waitForDriver = async () => {
  const deadline = Date.now() + 15_000;
  let last = "driver did not become ready";
  while (Date.now() < deadline) {
    if (driver.exitCode !== null) throw new Error(`tauri-driver exited with ${driver.exitCode}: ${last}`);
    try {
      await request("GET", "/status");
      return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      await sleep(100);
    }
  }
  throw new Error(`${last}; tauri-driver output was not included because it may contain platform paths`);
};

const waitForElement = async (sessionId, selector) => {
  const deadline = Date.now() + 20_000;
  let last = "element not found";
  while (Date.now() < deadline) {
    try {
      return await request("POST", `/session/${sessionId}/element`, { using: "css selector", value: selector });
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      await sleep(150);
    }
  }
  throw new Error(`${last}: ${selector}`);
};

const elementId = (element) => element?.["element-6066-11e4-a52e-4f735466cecf"] ?? element?.ELEMENT;
const attr = async (sessionId, element, name) => request("GET", `/session/${sessionId}/element/${elementId(element)}/attribute/${name}`);
const text = async (sessionId, element) => request("GET", `/session/${sessionId}/element/${elementId(element)}/text`);
const click = async (sessionId, element) => request("POST", `/session/${sessionId}/element/${elementId(element)}/click`, {});
const waitForText = async (sessionId, selector, needle, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  let last = "element text did not match";
  while (Date.now() < deadline) {
    try {
      const element = await request("POST", `/session/${sessionId}/element`, { using: "css selector", value: selector });
      const value = await text(sessionId, element);
      if (typeof value === "string" && value.includes(needle)) return value;
      last = `text did not include ${needle}: ${String(value)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(50);
  }
  throw new Error(`${last}: ${selector}`);
};

let sessionId = null;
let result;
try {
  await waitForDriver();
  const session = await request("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        "tauri:options": { application: app },
      },
    },
  });
  sessionId = session?.sessionId;
  if (!sessionId) throw new Error("WebDriver session response did not include sessionId");

  const title = await request("GET", `/session/${sessionId}/title`);
  if (title !== "EastGenesis Desktop") throw new Error(`unexpected document title: ${String(title)}`);

  const input = await waitForElement(sessionId, "textarea");
  const placeholder = await attr(sessionId, input, "placeholder");
  if (typeof placeholder !== "string" || !placeholder.includes("任务")) throw new Error(`unexpected task input placeholder: ${String(placeholder)}`);

  const submitBefore = await waitForElement(sessionId, 'button[aria-label="提交任务"]');
  const disabledBefore = await attr(sessionId, submitBefore, "disabled");
  if (disabledBefore !== "true") throw new Error(`submit button should start disabled: ${String(disabledBefore)}`);

  await request("POST", `/session/${sessionId}/element/${elementId(input)}/value`, {
    text: "把 hello 翻译成中文",
  });

  const preview = await waitForElement(sessionId, '[role="status"][aria-label="预计工作能力"]');
  const previewText = await text(sessionId, preview);
  if (typeof previewText !== "string" || !previewText.includes("预计")) throw new Error(`unexpected route preview: ${String(previewText)}`);

  const submit = await waitForElement(sessionId, 'button[aria-label="提交任务"]');
  const disabled = await attr(sessionId, submit, "disabled");
  if (disabled === "true") throw new Error("submit button stayed disabled after entering a task");

  let streamChecks = {};
  if (stream) {
    const submittedAt = Date.now();
    await click(sessionId, submit);
    await waitForElement(sessionId, 'article[aria-label^="任务："]');
    if (scenario === "idle-cancel") {
      // idle fixture flushes SSE headers and then waits; give the native fetch
      // bridge a moment to enter the read loop before exercising cancellation.
      await sleep(300);
      const stop = await waitForElement(sessionId, 'button[aria-label="停止任务"]');
      await click(sessionId, stop);
      await waitForText(sessionId, 'article[aria-label^="任务："]', "已停止", 10_000);
      streamChecks = {
        fixtureScenario: scenario,
        fixtureProviderInjected: true,
        taskSubmitted: true,
        cancellationRequested: true,
        cancelControl: true,
        cancelledResult: true,
      };
    } else if (scenario === "truncated") {
      await waitForText(sessionId, 'section[aria-label="部分输出"]', "已经收到一部分", 20_000);
      await waitForText(sessionId, 'article[aria-label^="任务："]', "失败", 20_000);
      streamChecks = {
        fixtureScenario: scenario,
        fixtureProviderInjected: true,
        taskSubmitted: true,
        firstOutputLatencyMs: Date.now() - submittedAt,
        partialOutputPreserved: true,
        terminalFailureVisible: true,
      };
    } else {
      await waitForText(sessionId, 'section[aria-label="正在生成"]', "第一段", 10_000);
      const firstChunkLatencyMs = Date.now() - submittedAt;
      if (scenario === "slow-first-token" && firstChunkLatencyMs < 200) {
        throw new Error(`slow-first-token fixture returned too early: ${firstChunkLatencyMs} ms`);
      }
      await waitForText(sessionId, 'section[aria-label="成果"]', "第一段第二段", 20_000);
      streamChecks = {
        fixtureScenario: scenario,
        fixtureProviderInjected: true,
        taskSubmitted: true,
        firstChunkLatencyMs,
        streamingFirstChunk: true,
        completedResult: true,
      };
    }
    streamChecks = {
      fixtureProviderInjected: true,
      ...streamChecks,
    };
  }

  result = {
    schemaVersion: 1,
    kind: "desktop-webdriver-smoke",
    passed: true,
    checks: {
      nativeWebDriverSession: true,
      documentTitle: true,
      taskInput: true,
      routePreview: true,
      submitState: true,
      ...streamChecks,
    },
    evidenceBoundary: {
      proven: [
        "real native WebDriver session",
        "Tauri WebView DOM render",
        "task input and local route preview interaction",
        ...(stream
          ? [
              "QA-only local Provider injection",
              "task submission",
              ...(scenario === "truncated" ? ["partial output preservation and visible terminal failure"] : []),
              ...(scenario === "idle-cancel" ? ["idle stream cancellation control"] : []),
              ...(!["truncated", "idle-cancel"].includes(scenario) ? ["SSE first chunk and completed result"] : []),
            ]
          : []),
      ],
      excluded: ["real Provider", "filesystem dialog", "signing/notarization", ...(stream ? [] : ["task submission", "streaming"])],
    },
  };
} finally {
  if (sessionId) {
    try { await request("DELETE", `/session/${sessionId}`); } catch { /* app may already have exited */ }
  }
  if (driver.exitCode === null) {
    driver.kill(process.platform === "win32" ? "SIGTERM" : "SIGTERM");
    await new Promise((resolveExit) => {
      const timer = setTimeout(resolveExit, 3_000);
      driver.once("exit", () => { clearTimeout(timer); resolveExit(); });
    });
  }
  if (fixture?.exitCode === null) {
    fixture.kill("SIGTERM");
    await new Promise((resolveExit) => {
      const timer = setTimeout(resolveExit, 3_000);
      fixture.once("exit", () => { clearTimeout(timer); resolveExit(); });
    });
  }
}

if (!result) throw new Error(`WebDriver smoke did not produce evidence${driverOutput ? ` (${driverOutput.trim().slice(0, 160)})` : ""}`);
console.log(JSON.stringify(result, null, 2));
