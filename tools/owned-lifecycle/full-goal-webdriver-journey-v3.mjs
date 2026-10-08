// Unexecuted cross-platform harness slice. This file does not start an App,
// bind a listener, or make a request when imported or checked with --static-only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

export const FIXED = Object.freeze({
  historicalProductionHead: 'de5df723397889e05b11d91b9405c28b18f3d3b4',
  historicalProductionTree: 'bec226b689754c8e87667d07a9aff4a506a1d740',
  historicalProductionFiles: 816,
  model: 'fixture-model',
  acceptedMarker: 'QA_FULL_ACCEPTED_CHAT',
  acceptedOutput: '分析项目并给出结论：QA_FULL_ACCEPTED_CHAT。代码修改完成。',
  fileBody: 'export const unifiedGoalResult = "synthetic verified artifact";\n',
  maxProviderPosts: 6,
  maxModelsGets: 2,
  maxBodyBytes: 131072,
  observerReadsPerProcess: 16,
  globalDeadlineMs: 180000,
  driverStartMs: 60000,
  sessionCreationMs: 60000,
  mutationRequestMs: 5000,
  observationMs: 15000,
});

const eq = (a, b) => assert.deepEqual(a, b);
const need = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { fixedCode: code }); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const elementId = (element) => element?.['element-6066-11e4-a52e-4f735466cecf'] ?? element?.ELEMENT;

// Returns an element reference through WebDriver's normal serialization.
// Only reads the DOM. It never calls click(), dispatchEvent(), sets a value,
// invokes a store, or uses the Tauri write API.
export const READ_EXACT_ELEMENT = `
const [q] = arguments;
const visible = e => e instanceof HTMLElement && e.getClientRects().length > 0
  && getComputedStyle(e).visibility !== 'hidden';
const roots = q.scope ? [...document.querySelectorAll(q.scope)].filter(visible) : [document];
if (roots.length !== 1) throw Error('scope_not_unique');
const root = roots[0];
let found;
if (q.kind === 'input') {
  found = [...root.querySelectorAll('label')].filter(e => e.textContent.trim() === q.label)
    .map(e => document.getElementById(e.htmlFor)).filter(visible);
  found.push(...[...root.querySelectorAll('input,textarea,select')]
    .filter(e => e.getAttribute('aria-label') === q.label && visible(e)));
} else if (q.kind === 'menu_primary') {
  if (!q.scope || root.getAttribute('role') !== 'menu'
    || !['menuitemradio','menuitemcheckbox'].includes(q.role)) throw Error('menu_scope_invalid');
  found = [...root.querySelectorAll('button')].filter(e => {
    if (!visible(e) || e.closest('[role="menu"]') !== root || e.getAttribute('role') !== q.role) return false;
    // MenuRadio/MenuCheckbox: one direct text-container span owns the first
    // direct primary-label span; its sibling hint is intentionally excluded.
    const primary = [...e.querySelectorAll(':scope > span > span:first-child')];
    return primary.length === 1 && primary[0].textContent.trim() === q.label;
  });
} else if (q.kind === 'selector') {
  found = [...root.querySelectorAll(q.selector)].filter(visible);
} else {
  found = [...root.querySelectorAll('button,[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"]')]
    .filter(e => visible(e) && (e.getAttribute('aria-label') === q.label
      || e.textContent.trim() === q.label
      || (q.titleExact === true && e.getAttribute('title') === q.label)
      || (q.ariaSuffix === true && (e.getAttribute('aria-label') ?? '').endsWith(q.label))));
}
found = [...new Set(found)];
if (found.length !== 1) throw Error('element_not_unique');
if (found[0].disabled || found[0].getAttribute('aria-disabled') === 'true') throw Error('element_disabled');
return found[0];`;

const READ_VALUE = 'return arguments[0].value;';
const READ_TEXT = 'return arguments[0].textContent;';
const READ_ATTRIBUTE = 'return arguments[0].getAttribute(arguments[1]);';

// transport.request must enforce the single global deadline. The request
// journal must be written before dispatch, including potentially ambiguous
// mutation timeouts. Never automatically resend a value/click/session POST.
export function makeUi(transport) {
  async function readElement(q) {
    const found = await transport.observeUntil(async () =>
      transport.request('POST', `/session/${transport.sessionId()}/execute/sync`,
        { script: READ_EXACT_ELEMENT, args: [q] }), FIXED.observationMs);
    need(typeof elementId(found) === 'string', 'webdriver_element_missing');
    return found;
  }
  async function read(script, args) {
    return transport.request('POST', `/session/${transport.sessionId()}/execute/sync`, { script, args });
  }
  async function click(label, scope, extra = {}) {
    const element = await readElement({ kind: 'button', label, scope, ...extra });
    // W3C element click, single dispatch. No JavaScript click fallback.
    await transport.request('POST', `/session/${transport.sessionId()}/element/${elementId(element)}/click`, {});
  }
  async function clickMenu(label, menuName, role) {
    const element = await readElement({ kind: 'menu_primary', label, role,
      scope: `[role="menu"][aria-label="${menuName}"]` });
    await transport.request('POST', `/session/${transport.sessionId()}/element/${elementId(element)}/click`, {});
  }
  async function input(label, value, scope) {
    const q = { kind: 'input', label, scope };
    const element = await readElement(q);
    need(await read(READ_VALUE, [element]) === '', 'input_not_initially_empty');
    // Only fresh empty fields: no clear(), prefix append, or replay on timeout.
    await transport.request('POST', `/session/${transport.sessionId()}/element/${elementId(element)}/value`, { text: value });
    eq(await read(READ_VALUE, [await readElement(q)]), value);
  }
  async function attr(q, name) { return read(READ_ATTRIBUTE, [await readElement(q), name]); }
  async function text(scope, required) {
    return transport.observeUntil(async () => {
      const element = await readElement({ kind: 'selector', selector: scope });
      const value = await read(READ_TEXT, [element]);
      need(typeof value === 'string' && required.every(t => value.includes(t)), 'expected_text_missing');
      return value;
    }, FIXED.observationMs);
  }
  async function checked(label, expected) {
    const e = await readElement({ kind: 'input', label });
    eq(await read('return arguments[0].checked;', [e]), expected);
  }
  async function expectedValue(label, expected, scope) {
    const e = await readElement({ kind: 'input', label, scope });
    eq(await read(READ_VALUE, [e]), expected);
  }
  async function selected(label, expected) {
    const e = await readElement({ kind: 'input', label });
    eq(await read('return arguments[0].selectedOptions[0].textContent;', [e]), expected);
  }
  async function rawText(selector) {
    return read(READ_TEXT, [await readElement({ kind: 'selector', selector })]);
  }
  return Object.freeze({ click, clickMenu, input, attr, text, checked, selected, expectedValue, rawText });
}

// Two key-free synthetic Providers. API Key and header fields remain untouched.
// Files use owned absolute paths on BOTH platforms; Windows Known Folders do
// not become a fresh Downloads directory by changing HOME or USERPROFILE.
export async function configureUi(ui, { baseUrls, ownedFilesDirectory }) {
  for (const role of ['a', 'b']) {
    const url = new URL(baseUrls[role]);
    need(url.protocol === 'http:' && url.hostname === '127.0.0.1'
      && url.pathname === `/${role}/v1` && !url.username && !url.password
      && !url.search && !url.hash, 'fixture_url_not_exact');
  }
  await ui.click('设置', '[aria-label="主导航"]');
  await ui.click('自定义中转站', '[aria-label="内容栏"]');
  for (const role of ['a', 'b']) {
    await ui.click('添加自定义 Provider');
    const scope = 'form[aria-label="添加自定义 Provider"]';
    await ui.input('名称', `QA ${role.toUpperCase()}`, scope);
    // The ID is generated by React, so observe rather than setting it.
    await ui.expectedValue('ID', `qa-${role}`, scope);
    await ui.input('Base URL', baseUrls[role], scope);
    await ui.input('默认模型', FIXED.model, scope);
    await ui.selected('协议', 'OpenAI 兼容（Chat Completions）');
    await ui.click('保存', scope);
    await ui.text(`li[aria-label="QA ${role.toUpperCase()}"]`, [`custom:qa-${role}/${FIXED.model}`, '未配置 Key']);
  }
  await ui.click('Provider 管理', '[aria-label="内容栏"]');
  await ui.checked('让路由使用本机 Ollama', false);
  await ui.click('路由偏好', '[aria-label="内容栏"]');
  await ui.selected('决策模型', '不使用（直接用规则引擎）');
  await ui.click('权限默认值', '[aria-label="内容栏"]');
  await ui.expectedValue('默认档位', 'confirm');
  await ui.click('能力矩阵', '[aria-label="内容栏"]');
  for (const role of ['a', 'b']) {
    const id = `custom:qa-${role}/${FIXED.model}`;
    await ui.checked(`启用 ${id}`, true);
    const scope = `[role="group"][aria-label="${id} 的能力"]`;
    for (const label of ['工具调用', '代码']) {
      const query = { kind: 'button', label, scope };
      eq(await ui.attr(query, 'aria-pressed'), 'false');
      await ui.click(label, scope);
      eq(await ui.attr(query, 'aria-pressed'), 'true');
    }
  }
  await ui.click('MCP 服务器', '[aria-label="内容栏"]');
  await ui.input('要加入允许列表的文件夹', ownedFilesDirectory, 'form[aria-label="添加允许访问的目录"]');
  await ui.click('加入', 'form[aria-label="添加允许访问的目录"]');
  await ui.text('ul[aria-label="允许访问的目录"]', [ownedFilesDirectory]);
  await ui.click('新任务', '[aria-label="主导航"]');
  await ui.click('路由');
  await ui.clickMenu('自动（推荐）', '路由', 'menuitemradio');
  await ui.click('添加');
  await ui.clickMenu('目标', '添加', 'menuitemcheckbox');
}

export async function createGoalUi(ui, description) {
  await ui.text('[aria-label="这次任务的设置"]', ['目标']);
  await ui.input('任务描述', description);
  await ui.click('提交任务');
  await ui.text('main[aria-label="目标"]', [description, '开始']);
}

export function classifyEnvelope(body) {
  need(body && Array.isArray(body.messages) && body.messages.length > 0 && body.messages.length <= 64
    && body.messages.every(m => m && typeof m.content === 'string' && typeof m.role === 'string')
    && body.model === FIXED.model && body.max_tokens !== 1, 'fixture_invalid_envelope');
  const system = body.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const flat = body.messages.map(m => m.content).join('\n');
  const purpose = system.includes('任务规划器') ? 'plan'
    : system.includes('你为工具生成调用参数') ? 'args'
    : flat.includes('各步骤结果') || flat.includes('请用简洁的中文直接给出最终成果') ? 'summary'
    : flat.includes('当前子目标') ? 'answer' : 'other';
  return { purpose, markerPresent: flat.includes(FIXED.acceptedMarker),acceptedOutputPresent:flat.includes(FIXED.acceptedOutput) };
}

export function createKnownFinalFixture({ sourceFile, resultFile, fatal }) {
  const counters = { get: 0, post: 0, other: 0 };
  const records = [];
  const sockets = new Set();
  let resumeAllowed = false;
  const reject = (code, res) => {
    fatal(code); res.writeHead(409, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"synthetic fixture rejected"}}');
  };
  const server = createServer((req, res) => {
    const match = /^\/(a|b)\/v1\/(models|chat\/completions)$/.exec(req.url ?? '');
    if (req.headers.authorization || req.headers['x-api-key']) return reject('unexpected_fixture_auth', res);
    if (!match) { counters.other++; return reject('unexpected_fixture_path', res); }
    const role = match[1];
    if (req.method === 'GET' && match[2] === 'models') {
      if (++counters.get > FIXED.maxModelsGets) return reject('models_get_limit', res);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: FIXED.model }] })); return;
    }
    if (req.method !== 'POST' || match[2] !== 'chat/completions') {
      counters.other++; return reject('unexpected_fixture_method', res);
    }
    const index = ++counters.post;
    if (index > FIXED.maxProviderPosts) return reject('provider_post_limit', res);
    let size = 0, chunks = [], rejected = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > FIXED.maxBodyBytes) { rejected = true; chunks = []; fatal('body_limit'); req.destroy(); }
      else chunks.push(chunk);
    });
    req.on('error', () => fatal('request_io_error'));
    req.on('end', () => {
      if (rejected) return;
      let body, roleInfo;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); roleInfo = classifyEnvelope(body); }
      catch { return reject('fixture_envelope_rejected', res); }
      chunks = [];
      const { purpose, markerPresent,acceptedOutputPresent } = roleInfo;
      const expected = [['a', 'plan'], ['a', 'answer'], ['b', 'answer'], ['a', 'summary'], ['b', 'summary'], ['a', 'summary']][index - 1];
      if (!same(expected, [role, purpose]) || (purpose === 'plan' ? body.stream === true : body.stream !== true)
        || index === 6 && (!resumeAllowed || !markerPresent || !acceptedOutputPresent)) return reject('fixture_order_rejected', res);
      records.push({ index, role, purpose, stream: body.stream === true, markerPresent,acceptedOutputPresent, bodyBytes: size, authPresent: false });
      if (purpose === 'plan') {
        const plan = { steps: [
          { goal: '读取项目文件', tool: 'mcp__files__read_file', args: { path: sourceFile } },
          { goal: '修改本地仓库代码文件', tool: 'mcp__files__write_file', args: { path: resultFile, content: FIXED.fileBody } },
          { goal: '分析项目并给出结论', tool: null },
        ] };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(plan) }, finish_reason: 'stop' }] }));
      } else if (purpose === 'answer' && role === 'a') {
        res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":{"message":"synthetic primary unavailable"}}');
      } else if (purpose === 'summary' && index <= 5) {
        res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"synthetic summary known terminal failure"}}');
      } else {
        const output = purpose === 'answer' ? `分析项目并给出结论：${FIXED.acceptedMarker}。代码修改完成。`
          : '读取项目文件、修改代码文件、分析项目并给出结论全部完成。';
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: output }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`);
      }
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  return Object.freeze({ server, counters, records, sockets, allowSingleSummaryResume() { resumeAllowed = true; } });
}

export function assertKnownFinalProjection(snapshot, idle, consumed, resumed) {
  need(snapshot.authorizesResume === false && snapshot.goalId === idle.goalId
    && snapshot.enrollmentId === idle.enrollmentId && snapshot.roundCount === 1, 'projection_identity');
  const a = snapshot.authority;
  need(a.limit === idle.authority.limit && a.consumed === consumed && a.pending === 0 && a.unknown === 0
    && a.succeeded === consumed - 1 && a.failed === 1 && a.active === false && a.ownerId === null && a.leaseUntil === 0, 'projection_authority');
  need(snapshot.mainReceipt.state === 'final' && snapshot.mainReceipt.llmCalls === (resumed ? 1 : 3)
    && snapshot.mainReceipt.terminalEvidence === true && snapshot.currentExecutionPermits.total === (resumed ? 1 : 3)
    && snapshot.currentExecutionPermits.mainPending === 0 && snapshot.currentExecutionPermits.mainUnknown === 0
    && snapshot.toolLedger.total === 2 && snapshot.toolLedger.states.applied === 2, 'projection_receipt_ledger');
}

export function assertOwnedWriteArguments(raw, resultFile) {
  need(typeof raw === 'string' && raw.length > 0 && raw.length <= 2000, 'write_confirmation_truncated');
  let args;
  try { args = JSON.parse(raw); } catch { throw Object.assign(new Error('write_confirmation_invalid_json'), { fixedCode: 'write_confirmation_invalid_json' }); }
  need(args && !Array.isArray(args) && Object.getPrototypeOf(args) === Object.prototype
    && same(Object.keys(args).sort(), ['content', 'path'])
    && args.path === resultFile && args.content === FIXED.fileBody, 'write_confirmation_not_exact_owned_args');
  return true;
}

// Runtime is a deliberately unimplemented OWNED LIFECYCLE adapter, not a mock.
// Before invoking this journey, it must physically validate the isolated App,
// source/build bindings, process ownership, exact fresh config/profile, env,
// SQLite read-only helper, file metadata, deadlines and complete cleanup.
// A missing lifecycle implementation must fail before fixture listen/session.
export async function runJourney(runtime, input) {
  const REQUIRED = ['startFirstOwnedSession', 'restartOwnedAppSessionSameProfile', 'discoverGoalIdReadOnly',
    'observeCanonical', 'readPhysicalCoherent', 'fingerprintOwnedFile', 'assertPhysicalTaskProof',
    'assertFreshCanonical', 'assertCompleteCleanup', 'sessionId', 'request', 'observeUntil'];
  need(REQUIRED.every(k => typeof runtime[k] === 'function'), 'owned_lifecycle_adapter_required');
  const ui = makeUi(runtime);
  await runtime.startFirstOwnedSession();
  await configureUi(ui, input);
  need(input.fixture.counters.post === 0 && input.fixture.counters.get === 2, 'pre_goal_wire_count');
  await createGoalUi(ui, input.description);
  const goalId = await runtime.discoverGoalIdReadOnly(input.description);
  const idle = await runtime.observeCanonical(goalId); runtime.assertFreshCanonical(idle);
  await ui.click('开始', 'main[aria-label="目标"]');
  await ui.text('[role="region"][aria-label="正在执行的一轮"]', ['mcp__files__write_file', '批准', 'unified-result.ts']);
  const confirmScope = '[role="region"][aria-label="正在执行的一轮"] [role="group"]';
  eq(await ui.rawText(`${confirmScope} > p > code`), 'mcp__files__write_file');
  const confirmRaw = await ui.rawText(`${confirmScope} > pre[aria-label="调用参数（已脱敏）"]`);
  assertOwnedWriteArguments(confirmRaw, input.resultFile);
  await ui.click('批准', confirmScope);
  await ui.text('main[aria-label="目标"]', ['这一轮执行出错，已暂停；继续时将恢复原任务', '继续']);
  need(input.fixture.counters.post === 5, 'initial_wire_count');
  const failed = await runtime.observeCanonical(goalId);
  assertKnownFinalProjection(failed, idle, 3, false);
  const before = await runtime.readPhysicalCoherent(goalId, failed);
  runtime.assertPhysicalTaskProof(before, false);
  const fileBefore = await runtime.fingerprintOwnedFile(input.resultFile);
  await ui.click('查看路由决策', 'main[aria-label="目标"]', { ariaSuffix: true });
  await ui.text('[aria-label="路由决策"]', ['qa-a/fixture-model', 'qa-b/fixture-model']);
  await ui.click('查看路由决策', 'main[aria-label="目标"]', { ariaSuffix: true });
  await runtime.restartOwnedAppSessionSameProfile();
  const restarted = await runtime.observeCanonical(goalId); eq(restarted, failed);
  eq(await runtime.readPhysicalCoherent(goalId, restarted), before);
  eq(await runtime.fingerprintOwnedFile(input.resultFile), fileBefore);
  need(input.fixture.counters.post === 5, 'restart_sent_model_request');
  // Row text also contains status; its actual DOM title is the description.
  await ui.click(input.description, '[aria-label="内容栏"]', { titleExact: true });
  input.fixture.allowSingleSummaryResume();
  await ui.click('继续', 'main[aria-label="目标"]');
  await ui.text('[role="region"][aria-label="等你确认"]', ['确认已完成']);
  need(input.fixture.counters.post === 6, 'resumed_wire_count');
  const resumed = await runtime.observeCanonical(goalId);
  assertKnownFinalProjection(resumed, idle, 4, true);
  const after = await runtime.readPhysicalCoherent(goalId, resumed);
  runtime.assertPhysicalTaskProof(after, true);
  eq(after.ledgerFingerprintSha256, before.ledgerFingerprintSha256);
  eq(await runtime.fingerprintOwnedFile(input.resultFile), fileBefore);
  eq(resumed.currentRound.taskId, failed.currentRound.taskId);
  need(resumed.execution.execution_id !== failed.execution.execution_id && resumed.execution.fence > failed.execution.fence, 'new_execution_missing');
  need(input.fixture.records.length === 6 && input.fixture.records.at(-1).purpose === 'summary'
    && input.fixture.records.at(-1).markerPresent === true && input.fixture.records.at(-1).acceptedOutputPresent === true, 'summary_only_resume_missing');
  await ui.click('确认已完成', '[role="region"][aria-label="等你确认"]');
  const final = await runtime.observeCanonical(goalId);
  need(final.status === 'completed' && final.currentRound.status === 'done', 'user_confirmed_completion_missing');
  // Complete cleanup is an additional necessary condition. An observation
  // success is never enough to mark the whole harness passed.
  await runtime.assertCompleteCleanup();
  return { goalId, idle, failed, restarted, resumed, final, before, after, fileBefore,
    syntheticOnly: true, userConfirmationByHarness: true, authorizesResume: false };
}

if (process.argv.includes('--static-only')) {
  eq(classifyEnvelope({ model: FIXED.model, messages: [{ role: 'system', content: '任务规划器' }] }), { purpose: 'plan', markerPresent: false,acceptedOutputPresent:false });
  eq(classifyEnvelope({ model: FIXED.model, messages: [{ role: 'user', content: `各步骤结果 ${FIXED.acceptedMarker}` }] }), { purpose: 'summary', markerPresent: true,acceptedOutputPresent:false });
  need(FIXED.maxProviderPosts === 6 && FIXED.maxModelsGets === 2 && FIXED.observerReadsPerProcess === 16, 'fixed_limits_changed');
  // No call of runJourney/createKnownFinalFixture occurs in this check.
  process.stdout.write(JSON.stringify({ kind: 'crossplatform_full_goal_draft_static_check',
    passed: true, syntaxAndPureHelpersOnly: true, nativeAttempted: false, fixtureListenerBound: false,
    httpRequests: 0, runtimeAdapterImplemented: false, fullGoalPassClaimed: false }) + '\n');
}
