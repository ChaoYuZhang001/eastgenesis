// Pure policy and state. No import-time filesystem, network, or process work.
import { createHash } from 'node:crypto';

export function fault(code) { return Object.assign(new Error(code), { fixedCode: code }); }
export function need(value, code) { if (!value) throw fault(code); }
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const pid = n => Number.isSafeInteger(n) && n > 0 && n <= 2147483647;
const sha = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const ticks = x => typeof x === 'string' && /^[1-9][0-9]{0,19}$/.test(x);
export const ENV_KEYS = Object.freeze(['PATH', 'HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'LANG', 'LC_ALL', 'DISPLAY', 'XAUTHORITY', 'WEBKIT_DISABLE_COMPOSITING_MODE', 'EASTGENESIS_QA_ISOLATED_PROFILE']);

// The caller supplies literal, owned values. This never spreads process.env.
export function freshEnvironment(values) {
  need(values && Object.getPrototypeOf(values) === Object.prototype, 'environment_invalid');
  need(Object.keys(values).every(k => ENV_KEYS.includes(k)), 'environment_key_forbidden');
  const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', WEBKIT_DISABLE_COMPOSITING_MODE: '1', EASTGENESIS_QA_ISOLATED_PROFILE: '1', ...values };
  for (const [key, value] of Object.entries(env)) need(typeof value === 'string' && value.length > 0 && !value.includes('\0') && value.length <= 4096, 'environment_value_invalid');
  for (const key of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR']) need(typeof env[key] === 'string' && env[key].startsWith('/') && !env[key].split('/').includes('..'), 'owned_environment_missing');
  need(env.EASTGENESIS_QA_ISOLATED_PROFILE === '1', 'qa_environment_missing');
  return Object.freeze(env);
}

export function assertControllerEnvironment(actual, expected) {
  // Unknown names are rejected without inspecting or printing their values.
  need(Object.keys(actual).every(k => ENV_KEYS.includes(k)), 'controller_environment_not_fresh');
  need(Object.keys(actual).length === Object.keys(expected).length, 'controller_environment_not_exact');
  for (const key of Object.keys(expected)) need(actual[key] === expected[key], 'controller_environment_not_exact');
}

export class MonotonicBudget {
  constructor({ now, totalMs, origin }) {
    need(typeof now === 'function' && Number.isSafeInteger(totalMs) && totalMs >= 1 && totalMs <= 300000, 'budget_invalid');
    this.now = now; this.origin = origin ?? now(); need(Number.isFinite(this.origin), 'clock_invalid');
    this.last = this.origin; this.deadline = this.origin + totalMs;
  }
  remaining() {
    const at = this.now(); need(Number.isFinite(at) && at >= this.last, 'monotonic_clock_regressed'); this.last = at;
    const remaining = this.deadline - at; need(remaining > 0, 'global_deadline_exceeded'); return remaining;
  }
  operationEnd(maxMs, inheritedEnd = Infinity) {
    need(Number.isFinite(maxMs) && maxMs > 0, 'operation_budget_invalid');
    this.remaining(); return Math.min(this.last + maxMs, this.deadline, inheritedEnd);
  }
  assertBefore(end) { this.remaining(); need(this.last < end, 'operation_deadline_exceeded'); }
}

export function validateIdentity(row) {
  need(row && pid(row.pid) && pid(row.parentPid) && pid(row.pgid) && pid(row.sid) && ticks(row.startTicks) && Number.isSafeInteger(row.uid) && row.uid >= 0, 'identity_schema_invalid');
  const e = row.exe;
  need(e && typeof e.path === 'string' && e.path.startsWith('/') && !e.path.split('/').includes('..') && sha(e.sha256), 'executable_schema_invalid');
  need(['dev','ino','size','mtimeNs','ctimeNs'].every(k => typeof e[k] === 'string' && /^(0|[1-9][0-9]*)$/.test(e[k])) && Number.isSafeInteger(e.mode), 'executable_identity_invalid');
  return structuredClone(row);
}

const identityFields = ['pid','parentPid','pgid','sid','startTicks','uid'];
export function assertSameIdentity(anchor, actual) {
  validateIdentity(anchor); validateIdentity(actual);
  need(identityFields.every(k => anchor[k] === actual[k]), 'process_identity_changed');
  need(digest(anchor.exe) === digest(actual.exe), 'executable_identity_changed');
}

export class OwnedRegistry {
  #rows = new Map(); #roles = new Map();
  constructor(owner) { const row = validateIdentity(owner); this.uid = row.uid; this.ownerPid = row.pid; this.#rows.set(row.pid, row); this.#roles.set('controller', row.pid); }
  register(role, row, parentPid, executable) {
    row = validateIdentity(row);
    need(typeof role === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(role) && !this.#roles.has(role) && !this.#rows.has(row.pid), 'role_or_pid_already_registered');
    need(this.#rows.has(parentPid) && row.parentPid === parentPid && row.uid === this.uid, 'owned_ancestry_invalid');
    need(executable && row.exe.path === executable.path && row.exe.sha256 === executable.sha256, 'unexpected_executable');
    this.#rows.set(row.pid, row); this.#roles.set(role, row.pid); return structuredClone(row);
  }
  bindUnique(role, candidates, parentPid, executable) {
    need(Array.isArray(candidates) && candidates.length <= 64, 'descendants_invalid');
    const matching = candidates.filter(row => row?.exe?.path === executable.path && row?.exe?.sha256 === executable.sha256);
    need(matching.length === 1, matching.length > 1 ? 'ambiguous_descendants' : 'owned_descendant_missing');
    return this.register(role, matching[0], parentPid, executable);
  }
  verify(role, actual) { const anchor = this.get(role); assertSameIdentity(anchor, actual); return anchor; }
  get(role) { need(this.#roles.has(role), 'role_unregistered'); return structuredClone(this.#rows.get(this.#roles.get(role))); }
  records() { return [...this.#rows.values()].map(row => structuredClone(row)); }
}

export function classifyCommand(method, path, body, session, readScripts) {
  need(typeof path === 'string' && path.startsWith('/') && !path.includes('?') && !path.includes('#'), 'command_path_invalid');
  if (method === 'GET' && path === '/status') return 'read';
  if (method === 'POST' && path === '/session' && !session) return 'session_create';
  need(typeof session === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(session), 'session_unbound');
  const base = `/session/${session}`;
  if (method === 'GET' && (path === `${base}/title` || /^\/session\/[A-Za-z0-9_-]+\/element\/[A-Za-z0-9_-]+\/attribute\/[A-Za-z0-9_-]+$/.test(path))) { need(path.startsWith(`${base}/`), 'session_identity_mismatch'); return 'read'; }
  if (method === 'POST' && path === `${base}/execute/sync`) {
    need(body && typeof body.script === 'string' && Array.isArray(body.args) && readScripts.has(digest(body.script)), 'script_not_read_allowlisted'); return 'read';
  }
  if (method === 'DELETE' && path === base) return 'session_delete';
  if (method === 'POST' && (path === `${base}/element` || path === `${base}/elements`)) return 'read';
  if (method === 'POST' && path.startsWith(`${base}/element/`) && /^\/session\/[A-Za-z0-9_-]+\/element\/[A-Za-z0-9_-]+\/(click|value)$/.test(path)) return 'mutation';
  throw fault('command_not_allowlisted');
}

export function validateSessionCapabilities(body, appPath) {
  need(body && digest(Object.keys(body).sort()) === digest(['capabilities']), 'capabilities_schema_invalid');
  const c = body.capabilities;
  need(c && digest(Object.keys(c).sort()) === digest(['alwaysMatch']) && c.alwaysMatch && digest(Object.keys(c.alwaysMatch).sort()) === digest(['tauri:options']), 'capabilities_schema_invalid');
  const opts = c.alwaysMatch['tauri:options'];
  need(opts && digest(Object.keys(opts).sort()) === digest(['application','args']) && opts.application === appPath && Array.isArray(opts.args) && opts.args.length === 0, 'capabilities_app_binding_invalid');
}

export function validateSessionReply(value) {
  need(value && typeof value.sessionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.sessionId), 'session_reply_invalid');
  need(value.capabilities && typeof value.capabilities === 'object' && !Array.isArray(value.capabilities), 'session_reply_invalid');
  const c=value.capabilities;
  const keys=['browserName','browserVersion','platformName','acceptInsecureCerts','setWindowRect','pageLoadStrategy','proxy','timeouts','strictFileInteractability','unhandledPromptBehavior','webkitgtk:browserOptions'];
  need(Object.keys(c).every(k=>keys.includes(k)) && typeof c.browserName==='string' && c.browserName.length>0 && c.browserName.length<=128, 'session_capabilities_invalid');
  for(const key of['browserVersion','platformName','pageLoadStrategy','unhandledPromptBehavior']) if(key in c)need(typeof c[key]==='string'&&c[key].length<=128,'session_capabilities_invalid');
  for(const key of['acceptInsecureCerts','setWindowRect','strictFileInteractability'])if(key in c)need(typeof c[key]==='boolean','session_capabilities_invalid');
  for(const key of['proxy','timeouts','webkitgtk:browserOptions'])if(key in c)need(c[key]&&typeof c[key]==='object'&&!Array.isArray(c[key])&&JSON.stringify(c[key]).length<=4096,'session_capabilities_invalid');
    need(Object.keys(value).every(k => ['sessionId','capabilities'].includes(k)), 'session_reply_invalid');
  return value.sessionId;
}

// Injected adapter exists to unit-test state with deterministic outcomes. The
// native factory alone supplies OS and HTTP adapters; tests never certify OS.
export class JournaledTransport {
  #session = null; #created = false; #tainted = false; #busy = false; #seq = 0; #observationEnds = [];
  constructor({ budget, journal, dispatch, sleep, appPath, readScripts, verifyBeforeDispatch, verifyAfterDispatch = verifyBeforeDispatch }) {
    need(budget instanceof MonotonicBudget && typeof journal?.append === 'function' && typeof dispatch === 'function' && typeof sleep === 'function' && typeof verifyBeforeDispatch === 'function', 'transport_adapter_invalid');
    Object.assign(this, { budget, journal, dispatch, sleep, appPath, readScripts: new Set(readScripts), verifyBeforeDispatch, verifyAfterDispatch });
  }
  sessionId() { need(this.#session !== null && !this.#tainted, 'session_unbound'); return this.#session; }
  state() { return { sessionBound: this.#session !== null, creationAttempted: this.#created, tainted: this.#tainted, dispatches: this.#seq }; }
  async request(method, path, body) {
    need(!this.#busy, 'concurrent_command_forbidden'); need(!this.#tainted, 'transport_ambiguous_outcome');
    const kind = classifyCommand(method, path, body, this.#session, this.readScripts);
    need(this.#observationEnds.length === 0 || kind === 'read', 'observation_mutation_forbidden');
    if (kind === 'session_create') { need(!this.#created, 'session_creation_already_attempted'); validateSessionCapabilities(body, this.appPath); }
    const cap = kind === 'session_create' ? 60000 : kind === 'read' ? 5000 : 5000;
    const end = this.budget.operationEnd(cap, Math.min(...this.#observationEnds, Infinity));
    this.#busy = true;
    let sent = false; const id = ++this.#seq;
    try {
      await this.verifyBeforeDispatch(); this.budget.assertBefore(end);
      // Persist and fsync first. Payload is represented solely by its hash.
      await this.journal.append({ id, event:'prepared', method, pathHash:digest(path), kind, bodyHash:body === undefined ? null : digest(body) });
      this.budget.assertBefore(end);
      if (kind === 'session_create') this.#created = true;
      sent = true;
      const reply = await this.dispatch({ method, path, body, deadline:end, timeoutMs: Math.max(1, Math.floor(end - this.budget.last)) });
      this.budget.assertBefore(end); // Late ACK is never usable evidence.
      await this.verifyAfterDispatch(); this.budget.assertBefore(end);
      need(reply && reply.httpStatus >= 200 && reply.httpStatus < 300 && reply.value?.error === undefined, 'webdriver_error_response');
      if (kind === 'session_create') this.#session = validateSessionReply(reply.value);
      if (kind === 'session_delete') this.#session = null;
      await this.journal.append({ id, event:'acknowledged', kind, responseHash:digest(reply.value ?? null) });
      this.budget.assertBefore(end);
      return reply.value;
    } catch (error) {
      if (sent && kind !== 'read') this.#tainted = true;
      await this.journal.append({ id, event:sent ? 'outcome_unaccepted' : 'not_dispatched', kind, code:error?.fixedCode ?? 'transport_failed', ambiguous:sent && kind !== 'read' }).catch(() => { this.#tainted = true; });
      throw error;
    } finally { this.#busy = false; }
  }
  async observeUntil(read, maxMs = 15000) {
    need(typeof read === 'function', 'observation_invalid');
    const end = this.budget.operationEnd(maxMs, Math.min(...this.#observationEnds, Infinity)); this.#observationEnds.push(end);
    try {
      for (;;) {
        this.budget.assertBefore(end);
        try { const value = await read(); this.budget.assertBefore(end); return value; }
        catch (error) {
          need(!this.#tainted, 'transport_ambiguous_outcome');
          // Only allowlisted read operations can be retried by observation.
          if (!['webdriver_error_response','observation_not_ready','owned_descendant_missing','transport_connection_refused'].includes(error?.fixedCode)) throw error;
          this.budget.assertBefore(end); await this.sleep(Math.min(100, end - this.budget.last));
        }
      }
    } finally { this.#observationEnds.pop(); }
  }
}
