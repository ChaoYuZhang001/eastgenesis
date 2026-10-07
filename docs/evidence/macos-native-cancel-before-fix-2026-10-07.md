# macOS native Provider cancellation evidence

Created: 2026-10-06T21:23:07.534Z. Finished: 2026-10-06T21:23:40.119Z.

Native transport acceptance: **failed**. Harness completed: true.

Binary SHA-256: `b7ce68b84a935cfb902535346d390c98b1491431ae75a758dd474c17ff90b96d`. Binary unchanged through run: true. Harness SHA-256: `0621aa3a76b61a115f87b7d8240fd81f32d345374127e64ca53822e0286c6e8b`.

The harness launched the actual macOS QA app with a fresh HOME/appdata, an owned synthetic loopback Provider and EASTGENESIS_QA_ISOLATED_PROFILE=1. It inherited only PATH and no Provider key environment, created the task through the PID-owned accessibility tree, first completed one synthetic warmup task through the UI so recorded successful LLM calls are nonempty, then submitted the cancellation task, waited for response headers plus a visible initial delta, and clicked Stop. All recorded LLM calls and the canceled task route must be custom:qa. An interrupted simple answer has no successful llm event by design, so the warmup and canceled-route evidence are reported separately. SQLite was opened read-only; no task or ledger state was seeded.

| Live-app assertion | Result |
| --- | --- |
| sourceHeadersAndDeltaPrecededStop | true |
| initialDeltaVisibleBeforeStop | true |
| appAliveBeforeCleanup | true |
| sqliteAborted | true |
| partialOutputMatchesInitialDelta | true |
| nonemptyRecordedLlmCallsOnlySyntheticQa | true |
| canceledTaskSelectedRouteOnlySyntheticQa | true |
| responseClosedWithinWindowWhileAppAlive | false |
| peerSocketClosedWithinWindowWhileAppAlive | false |
| providerConfigNotPersisted | true |
| stoppedUiVisible | true |
| partialOutputVisibleAfterStop | true |
| sqlitePartialOutputStableAfterStop | true |

The 1500 ms observation begins at a millisecond precision Foundation NSDate timestamp sampled after the button is located and immediately before the owned AX click. AX search/operation duration is recorded separately and cannot consume the cancellation window. The timestamp is validated to lie between the Node operation start and return. Socket close latency uses this same action origin and therefore includes the click itself. Actual observed elapsed: 1500.97900390625 ms. SQLite abort observed after 148.97900390625 ms. Stop control elapsed: 1755 ms.

The pre-cleanup socket/response snapshot is recorded before process cleanup. The fixture emits no further delta and never ends the idle response during observation. A close caused by app teardown cannot satisfy prompt cancellation acceptance. Pre-cleanup peer socket close: not observed; response close: not observed. Controlled app cleanup: true. A cleanup-induced close is recorded only as cleanup evidence.

Source binding: unknown_without_build_manifest. Git content reference: `aebe9c8acb4c1c583e0e90863f88c3f9f1e840e5`; native net production-prefix SHA-256 `90b3487a932c95d6bdfdf745f4f64d74a2b09231f2449a52efdb1242dae22791`. Current source snapshots are independently hashed at start/end and do not imply they were compiled into this binary. Actual complete binary-to-source compilation provenance remains unknown without a build manifest.

Excluded: real Provider requests, remote compute/billing, worker/stream registry release without a dedicated native probe, headers-before-first-token cancellation, late-delta discard, Windows/Linux, signing/notarization. The JSON report contains hashes and fixed assertions, no credentials, Provider URL, request bodies, raw accessibility tree, task IDs or user paths.
