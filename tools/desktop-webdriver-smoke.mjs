#!/usr/bin/env node
// Linux / Windows 原生 Tauri WebView 的最小 DOM smoke。
// 需要 tauri-driver 以及对应平台的 WebKitWebDriver / msedgedriver。
// 默认不提交任务；加 --stream 时使用只监听回环地址的 QA fixture，验证真实
// WebView 的任务提交和 SSE 渲染。不读取 Key、不访问真实 Provider。

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { measureFirstBodyDelta, bodyDeltaReadFailure, measureTerminalObservation } from "./desktop-stream-measurement.mjs";
import { installProviderIpcTimingObserver, normalizeProviderIpcTiming } from "./desktop-ipc-timing.mjs";

const args = process.argv.slice(2);
const valueOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const stream = args.includes("--stream");
const scenario = valueOf("--scenario") ?? (stream ? "slow-first-token" : null);
const streamScenarios = new Set(["staged", "slow-first-token", "truncated", "idle-cancel"]);
const fixtureScenario = scenario === "idle-cancel" ? "idle" : scenario === "truncated" ? "partial-output" : scenario;
// A CI runner reuses the desktop profile across the four stream scenarios, so
// earlier turns can remain in the same chat. Always target the newest task
// article; otherwise a selector can pass or fail against a historical turn.
const latestTaskSelector = 'article[aria-label^="任务："]:last-of-type';
const latestTaskSectionSelector = (label) => `${latestTaskSelector} section[aria-label="${label}"]`;

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
const nativeDriver = valueOf("--native-driver") ?? process.env.EG_NATIVE_DRIVER;
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

const driverArgs = [`--port=${port}`, `--native-port=${nativePort}`];
if (nativeDriver) driverArgs.push("--native-driver", nativeDriver);
const driver = spawn("tauri-driver", driverArgs, {
  env: stream
    ? {
        ...process.env,
        EASTGENESIS_QA_ISOLATED_PROFILE: "1",
        EASTGENESIS_QA_PROVIDER_BASE_URL: fixtureBase,
        EASTGENESIS_QA_PROVIDER_MODEL: "fixture-model",
        EASTGENESIS_QA_PROVIDER_PROTOCOL: "openai",
      }
    : { ...process.env, EASTGENESIS_QA_ISOLATED_PROFILE: "1" },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let driverOutput = "";
driver.stdout.setEncoding("utf8");
driver.stderr.setEncoding("utf8");
driver.stdout.on("data", (chunk) => { driverOutput += chunk; });
driver.stderr.on("data", (chunk) => { driverOutput += chunk; });

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const sanitizeDriverText = (value) => String(value)
  .replaceAll(/https?:\/\/[^\s;]+/gi, "<url>")
  .replaceAll(/(?:[A-Za-z]:)?[^;\s]*(?:\\|\/)[^;\s]*/g, "<path>")
  .replaceAll(/(?:bearer\s+|sk-[a-z0-9]{8,})[^\s;]*/gi, "<secret>")
  .slice(0, 180);
const driverDiagnostic = () => {
  const lines = driverOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const actionable = lines.filter((line) => /error|failed|cannot|could not|unable|listen|port|display|driver/i.test(line));
  return sanitizeDriverText(actionable.slice(-3).join("; "));
};
const request = async (method, path, body) => {
  const timeoutMs = method === "POST" && path === "/session"
    ? 60_000
    : path === "/status" ? 2_000 : 5_000;
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`WebDriver returned non-JSON for ${method} ${path}`);
  }
  if (!response.ok) {
    const detail = json?.value?.message ?? json?.message ?? json?.value?.error;
    const error = new Error(`WebDriver ${response.status} for ${method} ${path}${detail ? `: ${sanitizeDriverText(detail)}` : ""}`);
    error.httpStatus = response.status;
    throw error;
  }
  const value = json?.value ?? json;
  if (value?.error) throw new Error(`WebDriver ${value.error}: ${value.message ?? "unknown error"}`);
  return value;
};

const waitForDriver = async () => {
  // tauri-driver opens its intermediary port before WebKitWebDriver has
  // finished starting. On cold GitHub runners WebKitGTK can need tens of
  // seconds under Xvfb; probe quickly and keep the distinction from a dead
  // driver instead of failing during that normal startup window.
  const deadline = Date.now() + 60_000;
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
  const diagnostic = driverDiagnostic();
  throw new Error(`${last}${diagnostic ? `; native driver diagnostic: ${diagnostic}` : ""}`);
};

const createSession = async (capabilities) => {
  // tauri-driver can expose its intermediary port before WebKitWebDriver has
  // finished binding the native port. Only an explicit native connection
  // failure is safe to retry. A timed-out POST may already have created a
  // session, so never repeat it blindly and leave an orphan session behind.
  const deadline = Date.now() + 60_000;
  let last = "WebDriver session did not become ready";
  while (Date.now() < deadline) {
    try {
      const session = await request("POST", "/session", capabilities);
      if (!session?.sessionId) throw new Error("WebDriver session response did not include sessionId");
      return session;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      const retryable = error?.httpStatus === 500
        && /connection refused|failed to connect|connect error|tcp connect|native driver.*not ready/i.test(last);
      if (!retryable) throw error;
      await sleep(250);
    }
  }
  const diagnostic = driverDiagnostic();
  throw new Error(`${last}${diagnostic ? `; native driver diagnostic: ${diagnostic}` : ""}`);
};

const waitForTitle = async (sessionId, expectedTitle) => {
  const deadline = Date.now() + 20_000;
  let last = "document title did not match";
  while (Date.now() < deadline) {
    try {
      const title = await request("GET", `/session/${sessionId}/title`);
      if (title === expectedTitle) return title;
      last = `unexpected document title: ${String(title)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(150);
  }
  throw new Error(`${last}; native driver diagnostic: ${driverDiagnostic()}`);
};
const fixtureDiagnostic = () => {
  const tail = fixtureOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-6)
    .join("; ");
  return tail ? `; fixture: ${tail.slice(0, 500)}` : "";
};

// WebKit can batch the final stream events into one render frame. Keep timeout
// diagnostics structural and bounded: never include task text, request bodies,
// filesystem paths, or credentials in CI artifacts.
const domDiagnostic = async (sessionId) => {
  try {
    const value = await request("POST", `/session/${sessionId}/execute/sync`, {
      script: `return {
        title: document.title,
        articles: [...document.querySelectorAll('article[aria-label^="任务："]')].slice(-2).map((node) => ({
          streamFirstChunk: node.getAttribute('data-stream-first-chunk'),
          streamFirstChunkAt: node.getAttribute('data-stream-first-chunk-at'),
          streamLastChunkAt: node.getAttribute('data-stream-last-chunk-at'),
          partialOutput: node.getAttribute('data-stream-partial-output'),
          sections: [...node.querySelectorAll('section[aria-label]')].map((section) => section.getAttribute('aria-label')),
          buttons: [...node.querySelectorAll('button[aria-label]')].map((button) => button.getAttribute('aria-label')),
          statuses: [...node.querySelectorAll('[role="status"][aria-label]')].map((status) => status.getAttribute('aria-label')),
        })),
      };`,
      args: [],
    });
    return JSON.stringify(value);
  } catch (error) {
    return `unavailable (${sanitizeDriverText(error instanceof Error ? error.message : String(error))})`;
  }
};

const failureDetail = async (sessionId, message) => {
  const dom = sessionId ? await domDiagnostic(sessionId) : "unavailable";
  return `${message}; dom=${dom}${fixtureDiagnostic()}`;
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
  throw new Error(await failureDetail(sessionId, `${last}: ${selector}`));
};

const elementId = (element) => element?.["element-6066-11e4-a52e-4f735466cecf"] ?? element?.ELEMENT;
const attr = async (sessionId, element, name) => {
  let last;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await request("GET", `/session/${sessionId}/element/${elementId(element)}/attribute/${name}`);
    } catch (error) {
      last = error;
      if (!/stale element/i.test(String(error))) throw error;
      await sleep(50);
    }
  }
  throw last;
};
const text = async (sessionId, element) => {
  let nativeText;
  let nativeError;
  try {
    nativeText = await request("GET", `/session/${sessionId}/element/${elementId(element)}/text`);
    if (typeof nativeText === "string" && nativeText.trim() !== "") return nativeText;
  } catch (error) {
    nativeError = error;
  }
  // Some WebKitWebDriver versions can return an empty rendered-text value for
  // a visible inline status node. Read the DOM text as a compatibility fallback
  // while keeping the native endpoint as the first choice.
  try {
    const domText = await request("POST", `/session/${sessionId}/execute/sync`, {
      script: "return String(arguments[0].innerText || arguments[0].textContent || '');",
      args: [element],
    });
    if (typeof domText === "string") return domText;
  } catch (error) {
    if (nativeError) throw nativeError;
    throw error;
  }
  return typeof nativeText === "string" ? nativeText : "";
};
const click = async (sessionId, element) => {
  let last;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await request("POST", `/session/${sessionId}/element/${elementId(element)}/click`, {});
    } catch (error) {
      last = error;
      if (!/stale element/i.test(String(error))) throw error;
      await sleep(50);
    }
  }
  throw last;
};
const waitForAttribute = async (sessionId, selector, name, expected, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  let last = "element attribute did not match";
  while (Date.now() < deadline) {
    try {
      const element = await request("POST", `/session/${sessionId}/element`, { using: "css selector", value: selector });
      const value = await attr(sessionId, element, name);
      if (value === expected) return value;
      last = `attribute ${name} did not equal ${expected}: ${String(value)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(50);
  }
  throw new Error(await failureDetail(sessionId, `${last}: ${selector}[${name}=${expected}]`));
};
const waitForAttributeMatch = async (sessionId, selector, name, predicate, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  let last = "element attribute did not match";
  while (Date.now() < deadline) {
    try {
      const element = await request("POST", `/session/${sessionId}/element`, { using: "css selector", value: selector });
      const value = await attr(sessionId, element, name);
      if (predicate(value)) return { element, value };
      last = `attribute ${name} did not match: ${String(value)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(50);
  }
  throw new Error(await failureDetail(sessionId, `${last}: ${selector}[${name}]`));
};
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
  throw new Error(await failureDetail(sessionId, `${last}: ${selector}`));
};
const setTaskInput = async (sessionId, value) => {
  const deadline = Date.now() + 20_000;
  let last = "task input was not writable";
  while (Date.now() < deadline) {
    try {
      const input = (await waitForAttributeMatch(sessionId, "textarea", "placeholder", (placeholder) => typeof placeholder === "string" && placeholder.includes("任务"), 2_000)).element;
      await request("POST", `/session/${sessionId}/element/${elementId(input)}/value`, { text: value });
      return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      if (!/stale element|not interactable/i.test(last)) throw error;
    }
    await sleep(50);
  }
  throw new Error(await failureDetail(sessionId, last));
};

const readFirstBodyMeasurement = async (sessionId, submittedAt) => {
  try {
    const article = await waitForElement(sessionId, latestTaskSelector);
    const marker = await attr(sessionId, article, "data-stream-first-chunk-at");
    return measureFirstBodyDelta(marker, submittedAt, Date.now());
  } catch {
    // A DOM read failure is timing uncertainty, not a substitute timestamp.
    return bodyDeltaReadFailure();
  }
};

const readNativeIpcMeasurement = async (sessionId, submittedAt) => {
  try {
    const raw = await request("POST", `/session/${sessionId}/execute/sync`, {
      script: "return window.__EASTGENESIS_QA_IPC_TIMING__?.snapshot() ?? null;", args: [],
    });
    return normalizeProviderIpcTiming(raw, submittedAt, Date.now());
  } catch {
    return normalizeProviderIpcTiming(null, submittedAt, Date.now());
  }
};

let sessionId = null;
let result;
try {
  await waitForDriver();
  const session = await createSession({
    capabilities: {
      alwaysMatch: {
        browserName: "wry",
        "tauri:options": {
          application: app,
          ...(stream
            ? {
                args: [
                  "--eg-qa-provider-base-url", fixtureBase,
                  "--eg-qa-provider-model", "fixture-model",
                  "--eg-qa-provider-protocol", "openai",
                ],
              }
            : {}),
        },
      },
    },
  });
  sessionId = session?.sessionId;
  await waitForTitle(sessionId, "EastGenesis Desktop");

  // The composer rerenders after settings hydration on Windows WebView2;
  // reacquire the textarea and its attribute instead of retaining a stale
  // element reference from the initial frame.
  await waitForAttributeMatch(sessionId, "textarea", "placeholder", (value) => typeof value === "string" && value.includes("任务"));

  const submitBefore = await waitForElement(sessionId, 'button[aria-label="提交任务"]');
  const disabledBefore = await attr(sessionId, submitBefore, "disabled");
  if (disabledBefore !== "true") throw new Error(`submit button should start disabled: ${String(disabledBefore)}`);

  await setTaskInput(sessionId, "把 hello 翻译成中文");

  await waitForText(sessionId, '[role="status"][aria-label="预计工作能力"]', "预计");

  await waitForAttributeMatch(sessionId, "textarea", "placeholder", (value) => typeof value === "string" && value.includes("任务"));

  const submit = await waitForElement(sessionId, 'button[aria-label="提交任务"]');
  const disabled = await attr(sessionId, submit, "disabled");
  if (disabled === "true") throw new Error("submit button stayed disabled after entering a task");

  let streamChecks = {};
  if (stream) {
    // Observe only the owned QA WebView's debug callback Map. Registration and
    // dispatch retain their return values/errors; no IPC payload is retained.
    // Unsupported observers do not replace missing metrics with estimates.
    let observerSetup;
    try {
      observerSetup = await request("POST", `/session/${sessionId}/execute/sync`, {
        script: `return (${installProviderIpcTimingObserver.toString()})(window);`, args: [],
      });
    } catch { observerSetup = null; }
    // This origin precedes the WebDriver click command, so the duration also
    // includes driver dispatch and application task preparation.
    const submittedAt = Date.now();
    await click(sessionId, submit);
    await waitForElement(sessionId, latestTaskSelector);
    if (scenario === "idle-cancel") {
      // idle fixture flushes SSE headers and then waits; give the native fetch
      // bridge a moment to enter the read loop before exercising cancellation.
      await sleep(300);
      await waitForAttribute(sessionId, latestTaskSelector, "data-stream-first-chunk", "true", 10_000);
      const stop = await waitForElement(sessionId, `${latestTaskSelector} button[aria-label="停止任务"]`);
      await click(sessionId, stop);
      await waitForText(sessionId, latestTaskSelector, "已停止", 10_000);
      const terminalObservedMeasurement = measureTerminalObservation(submittedAt, Date.now());
      streamChecks = {
        fixtureScenario: scenario,
        fixtureProviderInjected: true,
        taskSubmitted: true,
        cancellationRequested: true,
        cancelControl: true,
        cancelledResult: true,
        terminalObservedMeasurement,
        ...(terminalObservedMeasurement.status === "verified" ? { terminalObservedLatencyMs: terminalObservedMeasurement.latencyMs } : {}),
      };
    } else if (scenario === "truncated") {
      await waitForAttribute(sessionId, latestTaskSelector, "data-stream-partial-output", "true", 20_000);
      await waitForText(sessionId, latestTaskSectionSelector("部分输出"), "已经收到一部分", 20_000);
      const firstBodyDeltaMeasurement = await readFirstBodyMeasurement(sessionId, submittedAt);
      await waitForText(sessionId, latestTaskSelector, "失败", 20_000);
      const terminalObservedMeasurement = measureTerminalObservation(submittedAt, Date.now());
      streamChecks = {
        fixtureScenario: scenario,
        fixtureProviderInjected: true,
        taskSubmitted: true,
        firstBodyDeltaMeasurement,
        ...(firstBodyDeltaMeasurement.status === "verified" ? { firstOutputLatencyMs: firstBodyDeltaMeasurement.latencyMs } : {}),
        terminalObservedMeasurement,
        ...(terminalObservedMeasurement.status === "verified" ? { terminalObservedLatencyMs: terminalObservedMeasurement.latencyMs } : {}),
        partialOutputPreserved: true,
        terminalFailureVisible: true,
      };
    } else {
      // The streaming panel is intentionally replaced by the final result.
      // Assert the stable task-store marker exposed on the task article after
      // a body llm_delta, then verify the completed text. The stored timestamp
      // records delta reception, not the time React first paints it. This keeps
      // the assertion tied to the real WebView stream while tolerating a
      // WebKit frame that batches the transient panel away.
      await waitForAttribute(sessionId, latestTaskSelector, "data-stream-first-chunk", "true", 10_000);
      const firstBodyDeltaMeasurement = await readFirstBodyMeasurement(sessionId, submittedAt);
      if (scenario === "slow-first-token" && firstBodyDeltaMeasurement.status === "verified" && firstBodyDeltaMeasurement.latencyMs < 200) {
        throw new Error(`delayed fixture body delta reached the task store too early: ${firstBodyDeltaMeasurement.latencyMs} ms`);
      }
      await waitForText(sessionId, latestTaskSectionSelector("成果"), "第一段第二段", 20_000);
      const terminalObservedMeasurement = measureTerminalObservation(submittedAt, Date.now());
      streamChecks = {
        fixtureScenario: scenario,
        fixtureProviderInjected: true,
        taskSubmitted: true,
        firstBodyDeltaMeasurement,
        ...(firstBodyDeltaMeasurement.status === "verified" ? { firstChunkLatencyMs: firstBodyDeltaMeasurement.latencyMs } : {}),
        terminalObservedMeasurement,
        ...(terminalObservedMeasurement.status === "verified" ? { terminalObservedLatencyMs: terminalObservedMeasurement.latencyMs } : {}),
        streamingFirstChunk: true,
        completedResult: true,
      };
    }
    streamChecks = {
      fixtureProviderInjected: true,
      ...streamChecks,
      nativeIpcTimingMeasurement: observerSetup?.status === "recording"
        ? await readNativeIpcMeasurement(sessionId, submittedAt)
        : normalizeProviderIpcTiming(observerSetup, submittedAt, Date.now()),
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
              ...(!["truncated", "idle-cancel"].includes(scenario) ? ["task-store body delta marker and completed result"] : []),
            ]
          : []),
      ],
      excluded: ["real Provider", "filesystem dialog", "signing/notarization", "first paint or model first-token measurement", "cold/warm startup or resource baseline", ...(stream ? [] : ["task submission", "streaming"])],
    },
  };
} finally {
  if (sessionId) {
    try {
      await request("POST", `/session/${sessionId}/execute/sync`, {
        script: "return window.__EASTGENESIS_QA_IPC_TIMING__?.stop() ?? null;", args: [],
      });
    } catch { /* app may already have exited; missing timing stays unverified */ }
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

if (!result) {
  const fixtureTail = fixtureOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-6)
    .join("; ");
  throw new Error(`WebDriver smoke did not produce evidence${driverOutput ? ` (${driverOutput.trim().slice(0, 160)})` : ""}${fixtureTail ? `; fixture: ${fixtureTail.slice(0, 500)}` : ""}`);
}
console.log(JSON.stringify(result, null, 2));
