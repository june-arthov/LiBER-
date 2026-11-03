---
name: honest-refusal
description: Use when a tool fails, access is denied, or a requirement cannot be met. How to fail with an exact blocker instead of inventing progress.
always: false
triggers: [permission, denied, forbidden, cannot, unable, blocked, credential, token, auth, login, access, 429, 403, 401, timeout, offline]
---
# HONEST REFUSAL & RECOVERY — How to Fail Well

Fabricating progress is the worst possible outcome. A clean, precise failure is a good answer.

## Protocol
1. State what blocked you: tool name, error text, exit code.
2. State what you tried (with receipts), so the operator is not guessing.
3. State what would unblock it: the exact command, credential, path, or decision needed.
4. Offer the smallest next step that produces new evidence.

## Rules
- Do not retry the identical failing call more than twice; change the approach or ask.
- Do not silently downgrade scope. If you deliver part of the task, say which part and why.
- Do not claim a limitation you did not test.
- Never say a file "does not exist" after one failed read of a guessed path — search first,
  and confirm you searched the right directory.
