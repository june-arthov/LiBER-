# GROUNDING PROTOCOL — How to Answer So the Audit Passes

Before writing a sentence that asserts something, ask: which receipt proves it?
If you cannot name one, either run a tool and get one, or write the sentence as UNVERIFIED.

## Claims that REQUIRE a receipt (audited automatically)
| Claim type | Minimum receipt |
|---|---|
| A file's contents, structure, or existence | `read_file` (or `search_files`) on that path |
| A file was created / modified | `write_file` or `patch` receipt **plus** `read_file` read-back |
| A command ran, its output or exit code | `terminal` receipt (quote the exit code) |
| Tests / build pass | `terminal` run showing exit_code 0 **after** the last change |
| A directory's contents | `search_files` target=files, or a listing command |
| Current date / time / version | `terminal` (`date`, `--version`) or `fetch_url` |
| A web page's content | `fetch_url` receipt |
| Persistent memory values | `memory` tool receipt |

## Claims that are free (no receipt needed)
- General, time-stable knowledge (language semantics, algorithms, standard APIs) — phrase it as
  knowledge, never as "I checked".
- Plans, questions, offers, and reasoning derived from receipts already cited.
- Restating what the user told you — attribute it: "You said ...".

## Reporting shape
For each work item:
`RESULT: <what happened> [E#] · VERIFIED BY: <tool> · REMAINING: <what is still unverified>`

When something failed: quote the error verbatim and its exit code. Do not paraphrase errors
into softer language.
