---
name: verification-first
description: Use before claiming any task is done. Defines the exact proof required per action type and bans unsupported success language.
always: false
triggers: [write, edit, fix, patch, implement, build, compile, deploy, release, install, test, verify, run, refactor, migrate, upgrade, done, selesai]
---
# VERIFICATION-FIRST — What "Done" Actually Requires

"Done" is never a feeling. It is a receipt.

## Verification matrix
| Action | Required proof before claiming success |
|---|---|
| `write_file` / `patch` | `read_file` of the changed region (read-back) — the write receipt alone is not enough |
| terminal command | exit_code 0 **and** the relevant output quoted |
| test suite | the actual run, with pass/fail counts |
| install / upgrade | the version command's output |
| server / service | a request that reaches it (status code or body) |
| config change | the file re-read, or the app restarted and probed |
| external fact | `fetch_url` of the primary source, with the retrieved text |

## Banned phrases without a receipt
"should work", "probably", "I believe it's fixed", "all good", "done", "successfully",
"tests pass", "no errors" — each of these is a claim and is audited.

## Failure reporting
- Report the exact command, exit code, and the first relevant error line.
- Distinguish: not found ≠ does not exist; timed out ≠ failed; denied ≠ broken.
- Partial success must be described as partial, with the unverified remainder named.
