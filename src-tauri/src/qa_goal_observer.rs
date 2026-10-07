//! Read-only observation approval for a guarded, isolated QA WebView.
//! No database, provider, keychain, execution claim, or resume operation lives here.

use serde::Serialize;
use std::sync::Mutex;
#[cfg(feature = "qa-faults")]
use std::sync::OnceLock;

const READ_LIMIT: u32 = 16;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Capability {
    protocol: &'static str,
    run_id: String,
    isolated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadApproval {
    run_id: String,
    goal_id: String,
}

#[derive(Default)]
struct Reads {
    goal_id: Option<String>,
    count: u32,
}

struct Observer {
    capability: Capability,
    reads: Mutex<Reads>,
}

fn valid_goal_id(value: &str) -> bool {
    let Some(stem) = value.strip_prefix("goal-") else {
        return false;
    };
    !stem.is_empty()
        && stem.len() <= 48
        && (stem.as_bytes()[0].is_ascii_lowercase() || stem.as_bytes()[0].is_ascii_digit())
        && stem
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

impl Observer {
    fn from_guarded_run(run_id: String, enabled: bool, keychain_isolated: bool) -> Option<Self> {
        if !enabled || !keychain_isolated || !super::qa_startup_diagnostics::valid_run_id(&run_id) {
            return None;
        }
        Some(Self {
            capability: Capability {
                protocol: "canonical-goal-observer-v1",
                run_id,
                isolated: true,
            },
            reads: Mutex::new(Reads::default()),
        })
    }

    fn capability(&self, main_webview: bool) -> Option<Capability> {
        main_webview.then(|| self.capability.clone())
    }

    fn approve(&self, main_webview: bool, run_id: &str, goal_id: &str) -> Option<ReadApproval> {
        if !main_webview || run_id != self.capability.run_id || !valid_goal_id(goal_id) {
            return None;
        }
        let mut reads = self.reads.lock().ok()?;
        if reads.count >= READ_LIMIT
            || reads
                .goal_id
                .as_ref()
                .is_some_and(|pinned| pinned != goal_id)
        {
            return None;
        }
        if reads.goal_id.is_none() {
            reads.goal_id = Some(goal_id.to_owned());
        }
        reads.count += 1;
        Some(ReadApproval {
            run_id: self.capability.run_id.clone(),
            goal_id: goal_id.to_owned(),
        })
    }
}

#[cfg(feature = "qa-faults")]
static OBSERVER: OnceLock<Observer> = OnceLock::new();

#[cfg(feature = "qa-faults")]
pub(crate) fn initialize() {
    let Some(run_id) = super::qa_startup_diagnostics::observation_run_id() else {
        return;
    };
    let enabled =
        std::env::var_os("EASTGENESIS_QA_GOAL_OBSERVER").is_some_and(|value| value == "1");
    let isolated =
        std::env::var_os("EASTGENESIS_QA_ISOLATED_PROFILE").is_some_and(|value| value == "1");
    if let Some(observer) = Observer::from_guarded_run(run_id, enabled, isolated) {
        let _ = OBSERVER.set(observer);
    }
}

#[cfg(feature = "qa-faults")]
#[tauri::command]
pub(crate) fn qa_goal_snapshot_capability(webview: tauri::Webview) -> Option<Capability> {
    OBSERVER.get()?.capability(webview.label() == "main")
}

#[cfg(feature = "qa-faults")]
#[tauri::command]
pub(crate) fn qa_goal_snapshot_request(
    webview: tauri::Webview,
    run_id: String,
    goal_id: String,
) -> Option<ReadApproval> {
    OBSERVER
        .get()?
        .approve(webview.label() == "main", &run_id, &goal_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    const RUN_ID: &str = "01234567-89ab-cdef-0123-456789abcdef";
    fn observer() -> Observer {
        Observer::from_guarded_run(RUN_ID.to_owned(), true, true).unwrap()
    }

    #[test]
    fn requires_guarded_identity_explicit_opt_in_and_keychain_isolation() {
        assert!(Observer::from_guarded_run(RUN_ID.to_owned(), true, true).is_some());
        assert!(Observer::from_guarded_run(RUN_ID.to_owned(), false, true).is_none());
        assert!(Observer::from_guarded_run(RUN_ID.to_owned(), true, false).is_none());
        assert!(Observer::from_guarded_run("../private".to_owned(), true, true).is_none());
    }

    #[test]
    fn rejects_other_frames_other_runs_and_invalid_ids_before_pinning() {
        let observer = observer();
        assert!(observer.capability(false).is_none());
        assert!(observer.approve(false, RUN_ID, "goal-a").is_none());
        assert!(observer.approve(true, "other-run", "goal-a").is_none());
        for goal in ["", "goal-", "goal--bad", "goal-A", "goal-a/path", "goal-é"] {
            assert!(observer.approve(true, RUN_ID, goal).is_none());
        }
        assert!(observer
            .approve(true, RUN_ID, &format!("goal-{}", "a".repeat(49)))
            .is_none());
        assert_eq!(observer.reads.lock().unwrap().count, 0);
        assert!(observer.approve(true, RUN_ID, "goal-a").is_some());
    }

    #[test]
    fn pins_one_explicit_goal_and_caps_approved_reads() {
        let observer = observer();
        assert!(observer.approve(true, RUN_ID, "goal-a").is_some());
        assert!(observer.approve(true, RUN_ID, "goal-b").is_none());
        for _ in 1..READ_LIMIT {
            assert!(observer.approve(true, RUN_ID, "goal-a").is_some());
        }
        assert!(observer.approve(true, RUN_ID, "goal-a").is_none());
        assert_eq!(observer.reads.lock().unwrap().count, READ_LIMIT);
    }

    #[test]
    fn serializes_only_fixed_observation_fields() {
        let observer = observer();
        let capability = serde_json::to_value(observer.capability(true).unwrap()).unwrap();
        assert_eq!(
            capability,
            serde_json::json!({"protocol":"canonical-goal-observer-v1","runId":RUN_ID,"isolated":true})
        );
        let approval =
            serde_json::to_value(observer.approve(true, RUN_ID, "goal-a").unwrap()).unwrap();
        assert_eq!(
            approval,
            serde_json::json!({"runId":RUN_ID,"goalId":"goal-a"})
        );
    }
}
