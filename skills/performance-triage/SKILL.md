---
name: performance-triage
description: Use when something is slow or resource-heavy. Measure a baseline, find the bottleneck, fix one thing, re-measure with the same benchmark.
always: false
triggers: [slow, latency, performance, lambat, lemot, bottleneck, memory, cpu, optimize, optimasi, profiling, hang]
---
# PERFORMANCE TRIAGE — Numbers Before Opinions

An optimisation without a before/after measurement is a guess with extra steps.

## 1. Baseline first
- Define ONE benchmark that represents the complaint and run it 3 times; record min/median.
- Record the environment (hardware, versions, data size) with the same command output.
- If you cannot reproduce the slowness, say so and ask for the failing input.

## 2. Locate, do not guess
- Measure stage by stage (network, parse, compute, IO, render); report each stage's time.
- Use the platform tools available: `time`, `--prof`, `--cpu-prof`, `perf`, query plans/logs.
- Read the code path that the profile points at; do not optimise a path the profile ignores.

## 3. Change one variable
- Fix the single largest contributor first. Re-run the SAME benchmark.
- Report before → after with both numbers. No "should be faster now".
- If the change did not improve the metric, revert it and say so.

## 4. Guard against regression
- Add or update a test or benchmark command that would catch the regression.
- State the remaining bottleneck explicitly; do not imply the work is fully optimised.
