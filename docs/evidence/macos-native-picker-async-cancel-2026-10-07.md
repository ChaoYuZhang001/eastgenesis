# macOS native picker regression after async cancellation fix

All 13 original scenarios passed on the new QA native package.

Binary SHA-256: `56405de93a809cb6cfaedb5e74430592c59890f96cac918142e4312a63c6000d`. Frozen harness SHA-256: `f59edc15f920cec8a89c6cea794ecf74ef1862a13c0474c5ca6eb5e50d857da5`. Independent binary, harness, compiled manifest and all 21 source digests match at run start and end. Source working tree changes are included; formal release binding is false.

| Scenario | Result |
| --- | --- |
| workdir_cancel | passed |
| workdir_context | passed |
| project_context | passed |
| ungranted_write_denied | passed |
| settings_cancel | passed |
| explicit_root_grant | passed |
| authorized_read_write | passed |
| outside_write_denied | passed |
| symlink_read_denied | passed |
| symlink_write_denied | passed |
| root_removed | passed |
| removed_root_write_denied | passed |
| default_downloads_retained | passed |

The actual app and native picker were controlled only through the test PID. Each profile used fresh HOME/appdata, an owned synthetic loopback Provider and QA keychain isolation. The UI created all task records, and SQLite was opened read-only. Verified behavior covers selection/cancel, context without implicit file grants, explicit grant and revocation, authorized read/write, denied outside/symlink access, and retained default Downloads access. No real Provider, private configuration, signing/notarization or formal public release was tested.
