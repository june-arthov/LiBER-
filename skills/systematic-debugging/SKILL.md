---
name: systematic-debugging
description: Use when a bug, crash, failing test, or regression must be diagnosed. Four phases with a tight feedback loop before any fix.
always: false
triggers: [bug, error, fail, crash, broken, regression, debug, traceback, exception, rusak, gagal, tidak jalan]
---
# SYSTEMATIC DEBUGGING — Root Cause Before Fix

Iron rule: no fix without root-cause investigation. A patch that hides a symptom is a second bug.

## Phase 1 — Reproduce
- Read the full error, not the first line. Note file, line, code.
- Build a tight feedback loop: one command that goes red on this exact symptom and green when fixed.
- Confirm it is deterministic, or raise the reproduction rate until it is debuggable.
- Check recent changes (`git diff`, `git log -n 10`) before theorising.

## Phase 2 — Locate
- Trace the bad value upstream to its origin; fix the source, not the crash site.
- Find working code in the same repo and list every difference, however small.

## Phase 3 — Hypothesise
- Write 3–5 falsifiable hypotheses, ranked by likelihood and cost to test.
- Change ONE variable per probe. If the probe fails, discard the hypothesis — never stack fixes.

## Phase 4 — Fix
- Write the failing test first, then the minimal fix, then run that test and the wider suite.
- If three fixes have failed, stop: the architecture is wrong. Say so instead of trying a fourth.
