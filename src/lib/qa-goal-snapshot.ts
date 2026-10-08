import type { Db } from "./db";
import type { PublicCanonicalGoalSnapshot } from "./goal-snapshot";

export type QaGoalObserverErrorCode =
  | "qa_snapshot_not_allowed" | "qa_snapshot_busy" | "qa_snapshot_limit"
  | "qa_snapshot_unavailable" | "quota_invalid_request"
  | "quota_protocol_invalid" | "quota_storage_unknown";
export type QaGoalObserverResult =
  | { readonly ok: true; readonly snapshot: PublicCanonicalGoalSnapshot }
  | { readonly ok: false; readonly code: QaGoalObserverErrorCode };
export type QaGoalObserverRequest = (
  command: "qa_goal_snapshot_capability" | "qa_goal_snapshot_request",
  args?: Record<string, unknown>,
) => Promise<unknown>;

declare global {
  interface Window {
    __EG_QA_GOAL_SNAPSHOT__?: (explicitGoalId: string) => Promise<QaGoalObserverResult>;
  }
}

const goalIdPattern = /^goal-[a-z0-9][a-z0-9-]{0,47}$/;
const runIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const installationAttempted = new WeakSet<Window>();
const fixedError = (code: QaGoalObserverErrorCode): QaGoalObserverResult => Object.freeze({ ok: false, code });

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && Object.prototype.hasOwnProperty.call(descriptor, "value");
  });
}

function mainFrame(w: Window): boolean {
  try {
    const metadata = (w as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWebview?: { label?: unknown } } } }).__TAURI_INTERNALS__?.metadata;
    return w === window && w.top === w && metadata?.currentWebview?.label === "main";
  } catch { return false; }
}

function readError(error: unknown): QaGoalObserverResult {
  const code = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined;
  return fixedError(code === "quota_invalid_request" || code === "quota_protocol_invalid" || code === "quota_storage_unknown"
    ? code : "qa_snapshot_unavailable");
}

function mountControls(w: Window, read: (id: string) => Promise<QaGoalObserverResult>): void {
  const d = w.document;
  if (!d.body) return;
  const host = d.createElement("section"), toggle = d.createElement("button"), panel = d.createElement("div");
  Object.assign(host.style, {
    position: "fixed", right: "12px", bottom: "12px", zIndex: "2147483647",
    maxWidth: "min(480px, calc(100vw - 24px))", padding: "8px", border: "1px solid var(--eg-border-dark)",
    borderRadius: "6px", background: "var(--eg-surface-2)", color: "var(--eg-text-on-dark)", fontSize: "12px",
  });
  toggle.type = "button";
  toggle.textContent = "QA Goal snapshot";
  toggle.setAttribute("aria-expanded", "false");
  panel.hidden = true;
  Object.assign(panel.style, { maxHeight: "60vh", overflow: "auto", width: "440px", maxWidth: "100%" });
  let built = false;
  toggle.addEventListener("click", () => {
    if (!built) {
      built = true;
      const inputLabel = d.createElement("label"), input = d.createElement("input");
      const readButton = d.createElement("button"), resultLabel = d.createElement("label"), result = d.createElement("textarea");
      inputLabel.textContent = "QA Goal ID";
      input.id = "eg-qa-goal-snapshot-id";
      inputLabel.htmlFor = input.id;
      input.type = "text";
      input.autocomplete = "off";
      input.spellcheck = false;
      Object.assign(input.style, { display: "block", width: "100%", boxSizing: "border-box", color: "var(--eg-ink)", background: "var(--eg-paper)" });
      readButton.type = "button";
      readButton.textContent = "Read QA Goal snapshot";
      resultLabel.textContent = "QA Goal snapshot result";
      result.id = "eg-qa-goal-snapshot-result";
      resultLabel.htmlFor = result.id;
      result.readOnly = true;
      result.rows = 10;
      Object.assign(result.style, { display: "block", width: "100%", minHeight: "160px", boxSizing: "border-box", color: "var(--eg-ink)", background: "var(--eg-paper)" });
      readButton.addEventListener("click", () => {
        readButton.disabled = true;
        void read(input.value).then((value) => {
          result.value = JSON.stringify(value, null, 2);
        }, () => {
          result.value = JSON.stringify(fixedError("qa_snapshot_unavailable"));
        }).finally(() => { readButton.disabled = false; });
      });
      panel.append(inputLabel, input, readButton, resultLabel, result);
    }
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
  });
  host.append(toggle, panel);
  d.body.append(host);
}

/** QA-only caller must guard the lazy import at build time. This observer never grants execution. */
export async function installQaGoalObserver(db: Readonly<Pick<Db, "select">>, request: QaGoalObserverRequest): Promise<void> {
  try {
    if (typeof window === "undefined") return;
    const w = window;
    if (!mainFrame(w) || installationAttempted.has(w) || Object.prototype.hasOwnProperty.call(w, "__EG_QA_GOAL_SNAPSHOT__")) return;
    installationAttempted.add(w);
    const selectOnly = Object.freeze({ select: db.select.bind(db) });
    const capability = await request("qa_goal_snapshot_capability");
    if (!mainFrame(w) || !exactRecord(capability, ["protocol", "runId", "isolated"]) || capability.protocol !== "canonical-goal-observer-v1"
      || typeof capability.runId !== "string" || !runIdPattern.test(capability.runId) || capability.isolated !== true) return;
    const runId = capability.runId;
    let pinnedGoalId: string | null = null, attempts = 0, busy = false;
    const read = async (explicitGoalId: string): Promise<QaGoalObserverResult> => {
      try {
        if (!mainFrame(w) || typeof explicitGoalId !== "string" || !goalIdPattern.test(explicitGoalId)
          || pinnedGoalId !== null && pinnedGoalId !== explicitGoalId) return fixedError("qa_snapshot_not_allowed");
        if (busy) return fixedError("qa_snapshot_busy");
        if (attempts >= 16) return fixedError("qa_snapshot_limit");
        // Pin and occupy before awaiting a native ACK; neither failure nor lost ACK reopens another Goal.
        pinnedGoalId = explicitGoalId;
        attempts++;
        busy = true;
        try {
          let approval: unknown;
          try { approval = await request("qa_goal_snapshot_request", Object.freeze({ runId, goalId: explicitGoalId })); }
          catch { return fixedError("qa_snapshot_not_allowed"); }
          if (!mainFrame(w) || !exactRecord(approval, ["runId", "goalId"]) || approval.runId !== runId || approval.goalId !== explicitGoalId) return fixedError("qa_snapshot_not_allowed");
          const { readCanonicalGoalSnapshot, projectCanonicalGoalSnapshot } = await import("./goal-snapshot");
          const raw = await readCanonicalGoalSnapshot(selectOnly, explicitGoalId);
          if (!mainFrame(w)) return fixedError("qa_snapshot_not_allowed");
          return Object.freeze({ ok: true, snapshot: projectCanonicalGoalSnapshot(raw) });
        } catch (error) { return readError(error); }
        finally { busy = false; }
      } catch { return fixedError("qa_snapshot_unavailable"); }
    };
    Object.defineProperty(w, "__EG_QA_GOAL_SNAPSHOT__", { value: read, writable: false, configurable: false });
    mountControls(w, read);
  } catch {
    // Optional observations cannot fail startup or expose native/SQL error details.
  }
}
