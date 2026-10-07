//! Install-smoke preflight that runs before Tauri, storage or keychain startup.
//! The marker proves only that the executable understands the probe protocol;
//! isolation is proved by inspecting this compilation's generated Tauri context.

use std::ffi::{OsStr, OsString};
use std::io::{self, Write};
use tauri::utils::config::{AppDirectoriesOverride, Config};

pub const PROBE_ARGUMENT: &str = "--qa-install-isolation-probe";
const QA_ROOT: &str = "./eg-qa-appdata";
const SUPPORT_MARKER: &str = "EASTGENESIS_QA_INSTALL_ISOLATION_PROBE_SUPPORTED_V1_6F725CB3";

// `used` keeps the static in compiler output. A runtime black_box reference
// also keeps the contiguous bytes reachable through release LTO/linker GC.
#[used]
static PROBE_SUPPORT_BYTES: [u8; SUPPORT_MARKER.len()] =
    *b"EASTGENESIS_QA_INSTALL_ISOLATION_PROBE_SUPPORTED_V1_6F725CB3";

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeResult {
    schema_version: u32,
    kind: &'static str,
    passed: bool,
    qa_faults_enabled: bool,
    isolated_app_directories: bool,
    app_directories_override: Option<&'static str>,
    errors: Vec<&'static str>,
}

fn evaluate(config: &Config, qa_faults_enabled: bool) -> ProbeResult {
    // Compare the raw path representation: Path equality normalizes some dot
    // components and would admit spellings outside the exact QA contract.
    let isolated = matches!(
        config.app.app_directories_override.as_ref(),
        Some(AppDirectoriesOverride::Root(root)) if root.as_os_str() == OsStr::new(QA_ROOT)
    );
    let error = if !qa_faults_enabled {
        Some("qa_faults_disabled")
    } else if !isolated {
        Some("qa_isolation_missing")
    } else {
        None
    };
    ProbeResult {
        schema_version: 1,
        kind: "desktop-qa-install-isolation",
        passed: error.is_none(),
        qa_faults_enabled,
        isolated_app_directories: isolated,
        app_directories_override: isolated.then_some(QA_ROOT),
        errors: error.into_iter().collect(),
    }
}

fn requested_mode(args: &[OsString], required: bool) -> Option<bool> {
    if args.iter().any(|arg| arg == PROBE_ARGUMENT) {
        return Some(args.len() == 1);
    }
    required.then_some(true)
}

/// The sole generated context factory for both the preflight and desktop App.
/// Keeping one macro expansion also avoids duplicate macOS Info.plist symbols.
pub fn embedded_context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

/// Returns an exit code for a probe or rejected mandatory-isolation startup.
/// Successful guarded GUI startup returns None and continues through main.
/// No app/path APIs or external configuration files are consulted here.
pub fn early_exit_code() -> Option<i32> {
    std::hint::black_box(&PROBE_SUPPORT_BYTES);
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let required = std::env::var_os("EASTGENESIS_QA_INSTALL_ISOLATION_REQUIRED")
        .is_some_and(|value| value == "1");
    let valid_arguments = requested_mode(&args, required)?;
    let probe_requested = args.iter().any(|arg| arg == PROBE_ARGUMENT);
    // Constructing the shared embedded Context does not construct an App.
    let context = embedded_context();
    let mut result = evaluate(context.config(), cfg!(feature = "qa-faults"));
    if !valid_arguments {
        result.passed = false;
        result.errors = vec!["qa_probe_arguments"];
    }
    if !probe_requested && result.passed {
        return None;
    }
    let code = i32::from(!result.passed);
    // Explicit pipe writes work for Windows GUI-subsystem executables launched
    // with redirected stdout; no console is attached or created by this probe.
    let mut stdout = io::stdout().lock();
    if serde_json::to_writer(&mut stdout, &result).is_err()
        || stdout.write_all(b"\n").is_err()
        || stdout.flush().is_err()
    {
        return Some(1);
    }
    Some(code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn config_with(value: Option<AppDirectoriesOverride>) -> Config {
        let mut config = Config::default();
        config.app.app_directories_override = value;
        config
    }

    #[test]
    fn requires_qa_feature_and_exact_root() {
        let isolated = config_with(Some(AppDirectoriesOverride::Root(PathBuf::from(QA_ROOT))));
        assert!(evaluate(&isolated, true).passed);
        assert!(!evaluate(&isolated, false).passed);
        assert_eq!(evaluate(&isolated, false).errors, ["qa_faults_disabled"]);
        assert_eq!(
            evaluate(&config_with(None), true).errors,
            ["qa_isolation_missing"]
        );
        for path in [
            "",
            "./",
            "eg-qa-appdata",
            "../eg-qa-appdata",
            "./eg-qa-appdata/",
            "././eg-qa-appdata",
            "C:\\shared-data",
        ] {
            let result = evaluate(
                &config_with(Some(AppDirectoriesOverride::Root(path.into()))),
                true,
            );
            assert!(!result.passed, "unexpected QA root: {path}");
            assert_eq!(result.app_directories_override, None);
        }
    }

    #[test]
    fn partial_directory_overrides_never_satisfy_isolation() {
        let value = serde_json::from_str(r#"{"config":"./eg-qa-appdata"}"#).unwrap();
        assert!(!evaluate(&config_with(Some(value)), true).passed);
    }

    #[test]
    fn probe_and_mandatory_guard_dispatch_without_normal_startup_fallback() {
        assert_eq!(requested_mode(&[], false), None);
        assert_eq!(requested_mode(&[], true), Some(true));
        assert_eq!(requested_mode(&[PROBE_ARGUMENT.into()], false), Some(true));
        for args in [
            vec!["unknown".into(), PROBE_ARGUMENT.into()],
            vec![PROBE_ARGUMENT.into(), "extra".into()],
        ] {
            assert_eq!(requested_mode(&args, false), Some(false));
        }
    }

    #[test]
    fn result_exposes_only_fixed_vocabulary() {
        let result = evaluate(
            &config_with(Some(AppDirectoriesOverride::Root(
                "/synthetic/private-profile".into(),
            ))),
            true,
        );
        let serialized = serde_json::to_string(&result).unwrap();
        assert!(!serialized.contains("private-profile"));
        assert!(serialized.contains("qa_isolation_missing"));
    }
}
