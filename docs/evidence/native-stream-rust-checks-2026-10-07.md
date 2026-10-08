Rust stream cancellation patch verification

Current production network code compiled and tested against real local TCP fixtures. Native app IPC, external provider and release evidence remain separate.

- ordinary: 13 passed, 0 failed; 0.72s; /tmp/eg-native-stream-rust-ordinary-20261007.log
- qa_faults: 13 passed, 0 failed; 0.71s; /tmp/eg-native-stream-rust-qa-20261007.log
- core_provider: 12 passed, 0 failed; 0.00s; /tmp/eg-native-stream-core-provider-20261007.log

The three cancel cases returned and observed peer EOF/reset in less than 1 ms in both feature sets; assertions require less than 500 ms. The fixture retains sockets until observed EOF/reset and cannot count its own two-second cleanup as a close. Cancel fixture budgets are 800 ms read / 1 s total; production constants stay 60 s read / 180 s total.

Registry: at most 256 active/pending/finished records; pending and finished IDs expire after 180 s. Pending cancellation is consumed once; active/recently finished reuse is rejected; cleanup matches Arc identity. Existing unique UUID frontend IDs avoid cross-generation ambiguity after tombstone expiry.

Production prefix SHA256: d3e940bbef41e10b59183e3840c676c1f74a1a6adb450bcbe9c122f2ec153c28
