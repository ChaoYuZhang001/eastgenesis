# macOS goal fault recovery regression after async cancellation fix

All 3 original fault/recovery scenarios passed on the new QA native package.

Binary SHA-256: `56405de93a809cb6cfaedb5e74430592c59890f96cac918142e4312a63c6000d`. Frozen harness SHA-256: `235b13ce1c8b7bc08dd418f513a56a06c8505cc9d14c076e6136be8c257246bd`. The legacy harness records and rechecks its binary hash; its expected hash argument is additionally enforced by independent checks before and after execution. Binary, harness, compiled manifest and all 21 source digests match at both run boundaries. Source working tree changes are included; formal release binding is false.

| Scenario | Result |
| --- | --- |
| after_ledger_started | passed |
| after_tool_before_ledger_commit | passed |
| unknown_after_external_sandbox_removal | passed |

Each real Tauri app ran with a fresh HOME/appdata, owned synthetic loopback Provider and QA keychain isolation. The UI created goals, rounds, tasks and ledger records. SQLite was opened read-only; ledger records were never seeded. Actual process aborts exercised pre-tool and post-tool/pre-commit windows. Active leases blocked replay; expired leases recovered the same task through actual file probes without a duplicate move. Explicit external removal of only the owned sandbox output led to unknown/needs_user and no replay.

QA lease remains 30,000 ms; production lease remains 600,000 ms. The test does not prove immediate production takeover, arbitrary external-service crash durability, real Provider behavior, signing/notarization or formal public release. Controlled app/process cleanup passed for all 3 scenarios.
