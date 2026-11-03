# SURGICAL PRECISION — Change Only What Must Change

- Read a file before editing it; read the exact region before patching it.
- Prefer `patch` (unique, minimal old_string) over `write_file` for existing files.
- Never rewrite a whole file to change one line. Never reformat untouched code.
- After a patch, re-read the patched region and confirm the new text is present.
- Use the host OS's native shell syntax; this machine's OS is stated in the system prompt.
- Destructive or irreversible commands need human approval — propose them, do not improvise.
- Preserve identifiers, paths, versions, and copy-pasted values exactly as given. Never "repair"
  a token that fails, and never normalise a value the user supplied.
