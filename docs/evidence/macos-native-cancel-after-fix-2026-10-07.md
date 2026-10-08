# macOS native Provider cancellation evidence

Created: 2026-10-06T21:25:32.062Z. Finished: 2026-10-06T21:26:04.382Z.

Native transport acceptance: **passed**. Harness completed: true.

Binary SHA-256: `56405de93a809cb6cfaedb5e74430592c59890f96cac918142e4312a63c6000d`. Binary unchanged through run: true. Harness SHA-256: `0621aa3a76b61a115f87b7d8240fd81f32d345374127e64ca53822e0286c6e8b`.

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
| responseClosedWithinWindowWhileAppAlive | true |
| peerSocketClosedWithinWindowWhileAppAlive | true |
| providerConfigNotPersisted | true |
| stoppedUiVisible | true |
| partialOutputVisibleAfterStop | true |
| sqlitePartialOutputStableAfterStop | true |

The 1500 ms observation begins at a millisecond precision Foundation NSDate timestamp sampled after the button is located and immediately before the owned AX click. AX search/operation duration is recorded separately and cannot consume the cancellation window. The timestamp is validated to lie between the Node operation start and return. Socket close latency uses this same action origin and therefore includes the click itself. Actual observed elapsed: 1500.69287109375 ms. SQLite abort observed after 145.69287109375 ms. Stop control elapsed: 1901 ms.

The pre-cleanup socket/response snapshot is recorded before process cleanup. The fixture emits no further delta and never ends the idle response during observation. A close caused by app teardown cannot satisfy prompt cancellation acceptance. Pre-cleanup peer socket close: 21.69287109375; response close: 21.69287109375. Controlled app cleanup: true. A cleanup-induced close is recorded only as cleanup evidence.

Source binding: caller_build_manifest_matches_binary. No Git content reference supplied. Current source snapshots are independently hashed at start/end and do not imply they were compiled into this binary. The supplied build manifest declares the compiled source file hashes and is itself hash-bound to this report.

Excluded: real Provider requests, remote compute/billing, worker/stream registry release without a dedicated native probe, headers-before-first-token cancellation, late-delta discard, Windows/Linux, signing/notarization. The JSON report contains hashes and fixed assertions, no credentials, Provider URL, request bodies, raw accessibility tree, task IDs or user paths.

Independent build manifest verification: the new binary digest and all ten harness source-file digests match the build manifest at both run boundaries. `sourceWorkingTreeChangesIncluded=true`; `formalReleaseBinding=false`. This is local isolated QA evidence.
