# macOS QA startup readiness observations

Created: 2026-10-06T22:44:14.555Z. Finished: 2026-10-06T22:45:19.216Z. Passed: **true**. Failed stage: none. Platform: 26.7.1 / x64.

Binary SHA-256: `76af4ff199126b96c9ef31bdc4e66c4bbce70f7af514bd5ef0030fd7da74e1d0`. Compiled 25-file manifest SHA-256: `73bc427ade019cfcc8d2563696a519b1b59581fd8f622a3eb9b146713681d79f`. Harness SHA-256: `b189a4f414077701cf2b3587d658721683cfcaacff6274510485d22d1eac7475`. Swift observer source SHA-256: `8abfd8f648abfa72ba6a05bc418fe50168ecd468ef61743acbfb1d171425725c`. Worktree QA build; no signing/release qualification claimed. Start/end hashes bind the binary, 25 production sources, manifest, observer and cleanup helper. A changed binary/source aborts further launches and makes the report fail.

The fresh-profile phase uses new HOME/appdata without database or settings seeding. Relaunch uses that same initialized profile after controlled shutdown. OS caches were not controlled. SQLite file existence is only profile metadata. Readiness comes from the owned PID's WebView AX controls, with no substitute metric when a condition is missing.

Node stamps wall and monotonic clocks immediately before binary spawn. A prestarted persistent Swift observer stamps each event using Foundation Date. Its timestamps must lie between Node command send and event receipt (1 ms wall-clock rounding tolerance); Node wall/monotonic elapsed must agree within 5 ms. The reported upper bound is the larger of Foundation elapsed plus 1 ms and Node monotonic receipt elapsed. Polling targets 50 ms, but actual scan/observation gaps determine resolution. The basic-ready event also records its scan interval and previous scan completion; tree scans that exceed the bounded traversal are incomplete and cannot establish Splash absence. No strict 100 ms cadence is claimed.

| Phase | Metric | Successful/attempted | Min ms | Median ms | Max ms | p95 ms |
| --- | --- | --- | --- | --- | --- | --- |
| fresh_profile_first_launch | startup_basic_ready | 20/20 | 1159.458 | 1245.477 | 1368.881 | 1336.772 |
| fresh_profile_first_launch | input_roundtrip_submit_enabled | 20/20 | 1221.699 | 1304.450 | 1430.081 | 1408.725 |
| fresh_profile_first_launch | route_provider_probe_completed | 20/20 | 1343.110 | 1407.793 | 1548.960 | 1516.519 |
| initialized_profile_relaunch | startup_basic_ready | 20/20 | 1186.330 | 1266.485 | 1374.399 | 1368.403 |
| initialized_profile_relaunch | input_roundtrip_submit_enabled | 20/20 | 1242.033 | 1319.981 | 1429.156 | 1414.940 |
| initialized_profile_relaunch | route_provider_probe_completed | 20/20 | 1356.039 | 1439.624 | 1552.097 | 1528.677 |

The earliest basic-ready observation requires the owned active window, Splash absent, WebView present, visible enabled input and visible enabled route control. The second metric adds synthetic draft write/readback and actual submit-enabled verification. The third adds route/manual menu expansion and verifies visible QA provider plus visible enabled QA default model. These menu actions are extra interaction verification, not pure startup time. No submit/model-selection action is issued. The enabled automatic-mode menu item is then pressed to reset routing/close menus, the draft is cleared and submit disabled again before controlled owned-group termination. The reset action is observed directly; the trigger's internal mode text is not available as an AX static-text readback. Actual automaticRoutingResetActionsIssued: **40**; modelSelectionActionsIssued and submitActionsIssued remain **0**.

| Phase | Observation or extra action | Median ms | Maximum ms |
| --- | --- | --- | --- |
| fresh_profile_first_launch | observerAttachDelayMs | 3.192 | 24.113 |
| fresh_profile_first_launch | inputRoundtripAfterBasicMs | 60.878 | 90.233 |
| fresh_profile_first_launch | routeProbeAfterInputMs | 117.663 | 127.004 |
| fresh_profile_first_launch | maxObservationGapMs | 220.938 | 262.328 |
| fresh_profile_first_launch | maxScanDurationMs | 220.663 | 262.047 |
| fresh_profile_first_launch | meanScanDurationMs | 36.392 | 42.221 |
| initialized_profile_relaunch | observerAttachDelayMs | 3.401 | 5.090 |
| initialized_profile_relaunch | inputRoundtripAfterBasicMs | 54.576 | 64.943 |
| initialized_profile_relaunch | routeProbeAfterInputMs | 117.649 | 125.754 |
| initialized_profile_relaunch | maxObservationGapMs | 224.847 | 269.801 |
| initialized_profile_relaunch | maxScanDurationMs | 224.608 | 269.535 |
| initialized_profile_relaunch | meanScanDurationMs | 36.379 | 40.556 |

Swift compilation/observer startup, fixture startup, profile directory creation and binding checks occur outside each app launch clock. Owned app activation, observer attachment, actual scans and the named interaction probes occur inside that clock. The total run budget is 600000 ms with 15000 ms per observation, at most 20 samples per phase per run; bounded observer watchdog/cleanup can add at most 3 seconds each. All successful/failed samples are retained. Summary values use fully successful samples; p95 uses nearest rank and is omitted below 20 successful measurements. n1 pilots are never used for p95.

The synthetic fixture returns an empty /models directory to prevent production startup's automatic max_tokens=1 model probe. This tests a single explicitly configured QA default model. It excludes successful catalog discovery/probing and multi-model catalog scale effects; it is not a startup baseline for real multi-model users. Actual fixture request counts: `{"models":40,"inference":0,"startupProbe":0,"actualTaskSubmit":0,"unclassifiedInference":0,"other":0}`; any inference endpoint request makes the run fail. No owned CPU busy loop or resource sampler runs during formal measurement; ordinary desktop/OS background load remains uncontrolled.

Earlier pilot runs are embedded verbatim with SHA-256 bindings in JSON, including failures. The first failed pilot's one inference request is attributed to the production startup probe by source code and absence of any AX input/basic-ready event; its old fixture did not capture request-body classification, so that distinction is explicitly an inference. Later fixtures count startup probes versus task-like submissions from bounded request-body shape without persisting bodies.

| Prior run created | Passed | Retained samples | Inference requests | Failure |
| --- | --- | --- | --- | --- |
| 2026-10-06T22:29:15.772Z | false | 2 | 1 | samples_or_frozen_binding_failed |
| 2026-10-06T22:33:26.216Z | false | 2 | 0 | samples_or_frozen_binding_failed |
| 2026-10-06T22:34:27.513Z | true | 2 | 0 | none |
| 2026-10-06T22:36:33.841Z | true | 2 | 0 | none |
| 2026-10-06T22:39:35.426Z | false | 2 | 0 | samples_or_frozen_binding_failed |
| 2026-10-06T22:41:05.444Z | true | 2 | 0 | none |
| 2026-10-06T22:41:59.519Z | true | 2 | 0 | none |

Excluded: real Provider and remote billing, resource usage (including WK XPC processes), OS-cache cold/warm claims, signed production/release readiness, other platforms, arbitrary user profiles, successful catalog discovery/probing and model-scale impact.

Post-run review caveat: the Swift AX attribute helper folds read errors into nil. `scan.complete` means the traversal did not exceed its node/time budget; it does not prove that every AX attribute read succeeded. `SplashAbsent` therefore means the Splash markers were not observed in a traversal that completed within that budget. It is not proof of physical pixel disappearance, and no per-attribute AX error count was collected. Interpret these results as the recorded AX readiness observation upper bounds with that limitation.

All 120 metric events in the formal run had a nonzero previous scan completion timestamp; none matched on the first scan. Their local readiness observation intervals ranged from 21.211 to 90.560 ms. A future first-scan match would have an unknown previous interval because the observer starts that timestamp at zero. The current local intervals must not be used to claim a strict 50 or 100 ms polling cadence; the observed whole-run maximum gap of 269.801 ms remains the relevant limitation. This review adds context only; the frozen harness and JSON sample data were not changed.
