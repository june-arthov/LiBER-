// src/daemon/core/engine.js — Merlin Autonomous Turn Loop + Grounding Gate
const registry = require('./registry');
const circuitBreaker = require('./circuit-breaker');
const logger = require('../../utils/logger');
const { buildSystemPrompt } = require('./merlin-soul');
const { EvidenceLedger } = require('./evidence');
const grounding = require('./grounding');
const skills = require('./skills');
const budget = require('./budget');

const DEFAULT_GROUNDING = {
  enabled: true,
  max_repairs: 2,
  require_readback: true,
  require_citations: true,
  doctrine_budget_chars: 7000
};

class MerlinEngine {
  /**
   * Parse tool calls. Bracket/quote-aware so JSON strings containing ")" survive.
   */
  parseToolCalls(text) {
    const calls = [];
    const src = String(text);
    const re = /\[TOOL:\s*([a-zA-Z0-9_\-]+)\s*\(/g;
    let m;

    while ((m = re.exec(src)) !== null) {
      const name = m[1];
      const start = m.index + m[0].length;
      let depth = 1;
      let i = start;
      let quote = null;
      let escaped = false;

      for (; i < src.length; i++) {
        const ch = src[i];
        if (quote) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === quote) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      if (depth !== 0) continue;

      const argText = src.slice(start, i);
      let args;
      try {
        args = JSON.parse(argText);
      } catch {
        args = { raw: argText.trim() };
      }
      calls.push({ name, args, raw: src.slice(m.index, i + 1) });
      re.lastIndex = i + 1;
    }

    const shortcut = (regex, name, build) => {
      let match;
      while ((match = regex.exec(src)) !== null) {
        calls.push({ name, args: build(match), raw: match[0] });
      }
    };

    shortcut(/\[EXEC:\s*([\s\S]*?)\]/g, 'terminal', mm => ({ command: mm[1].trim() }));
    shortcut(/\[READ:\s*([^\s\]]+)\]/g, 'read_file', mm => ({ path: mm[1].trim() }));
    shortcut(/\[WRITE:\s*([^\s\]]+)\]([\s\S]*?)\[\/WRITE\]/g, 'write_file', mm => ({ path: mm[1].trim(), content: mm[2].trim() }));

    return calls;
  }

  /**
   * Balanced-bracket slice starting at an opening '['.
   * Handles citations like [E1] inside a [THOUGHT: ...] block.
   */
  balancedSlice(src, start) {
    let depth = 0;
    for (let i = start; i < src.length; i++) {
      const ch = src[i];
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) return src.slice(start, i + 1);
      }
    }
    return null;
  }

  stripThoughts(text) {
    let out = String(text);
    let idx;
    while ((idx = out.search(/\[THOUGHT:/i)) >= 0) {
      const block = this.balancedSlice(out, idx);
      if (!block) break;
      out = out.slice(0, idx) + out.slice(idx + block.length);
    }
    return out
      .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
      .replace(/<\/?thought>/gi, '');
  }

  /**
   * Native tool-call arguments arrive as a JSON string (or object on some providers).
   */
  parseNativeArgs(raw) {
    if (raw && typeof raw === 'object') return raw;
    try {
      const parsed = JSON.parse(String(raw || '{}'));
      return parsed && typeof parsed === 'object' ? parsed : { raw: String(raw || '') };
    } catch {
      return { raw: String(raw || '') };
    }
  }

  extractThought(text) {
    const src = String(text);
    const t = src.search(/\[THOUGHT:/i);
    if (t >= 0) {
      const block = this.balancedSlice(src, t);
      if (block) {
        const body = block.replace(/^\[THOUGHT:\s*/i, '').replace(/\]\s*$/, '').trim();
        return body || null;
      }
    }
    const m = src.match(/<thought>([\s\S]*?)<\/thought>/i);
    return m ? m[1].trim() : null;
  }

  /**
   * Capture reasoning whether or not the model used a [THOUGHT:] tag.
   * Untagged prose before the first tool/final marker is real reasoning and must be shown.
   */
  extractReasoning(text) {
    const src = String(text);
    const tagged = this.extractThought(src);

    const marker = src.search(/\[(?:TOOL|EXEC|READ|WRITE|FINAL):/i);
    let preamble = '';
    if (marker > 0) {
      preamble = this.stripThoughts(src.slice(0, marker))
        .replace(/<\/?thought>/gi, ' ')
        .trim();
    }

    if (tagged) {
      return { content: preamble ? `${tagged}\n\n${preamble}` : tagged, kind: 'tagged' };
    }
    if (preamble.length >= 24) {
      return { content: preamble, kind: 'preamble' };
    }
    return null;
  }

  /**
   * Extract [FINAL: ...] without truncating on citation brackets like [E1].
   */
  extractFinal(text) {
    const src = String(text);
    const m = src.match(/\[FINAL:\s*/i) || src.match(/^[ \t]*FINAL:\s*/im);
    if (!m) return null;

    let body = src.slice(m.index + m[0].length).trimEnd();
    if (body.endsWith(']')) {
      const opens = (body.match(/\[/g) || []).length;
      const closes = (body.match(/\]/g) || []).length;
      // Drop only the wrapper's own closing bracket, not a citation's.
      if (closes === opens + 1) body = body.slice(0, -1).trimEnd();
    }
    return body.trim();
  }

  cleanAnswer(text) {
    return this.stripThoughts(String(text))
      .replace(/\[\/?(?:TOOL|EXEC|READ|WRITE|FINAL):[\s\S]*?\]/gi, '')
      .trim();
  }

  /**
   * Compress conversation history if token pressure is high.
   */
  compressContext(messages, maxTokens = 14000) {
    const estimatedChars = JSON.stringify(messages).length;
    const estimatedTokens = Math.floor(estimatedChars / 3.8);

    if (estimatedTokens <= maxTokens || messages.length <= 6) {
      return messages;
    }

    const systemMsg = messages[0];
    const recent = messages.slice(-6);
    const middle = messages.slice(1, -6);

    const summaryContent = middle
      .map(m => {
        if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
          return `ASSISTANT: [calls ${m.tool_calls.map(t => t.function?.name || 'tool').join(', ')}]`;
        }
        const text = String(m.content || '');
        if (m.role === 'user' && text.startsWith('OBSERVATION')) return `TOOL: ${text.slice(0, 200)}`;
        if (text.startsWith('GROUNDING AUDIT') || text.startsWith('DUPLICATE CALL')) return `SYSTEM: ${text.slice(0, 160)}`;
        return `${m.role.toUpperCase()}: ${text.slice(0, 160)}`;
      })
      .join(' | ');

    const summaryMessage = {
      role: 'system',
      content: `[CONTEXT COMPRESSION — earlier turns summarised; receipts remain in the Evidence Ledger] ${summaryContent.slice(0, 1400)}`
    };

    return [systemMsg, summaryMessage, ...recent];
  }

  async runTurn({
    agentId,
    agentConfig,
    userMessage,
    memory,
    llmManager,
    onEvent = () => {},
    waitForHitl = async () => true,
    maxLoops = 12
  }) {
    const cfg = { ...DEFAULT_GROUNDING, ...(agentConfig.grounding || {}) };
    const ledger = new EvidenceLedger(agentId);
    const skillCtx = skills.buildContext(String(userMessage || ''), cfg.doctrine_budget_chars);

    circuitBreaker.configureLimit(agentId, maxLoops);
    circuitBreaker.reset(agentId);

    memory.add(agentId, 'user', userMessage);
    logger.info(agentId, 'USER_MESSAGE_START', { userMessage });

    const history = memory.get(agentId).map(m => ({ role: m.role, content: m.content }));
    let messages = [{ role: 'system', content: '' }, ...history];

    let finalResponse = '';
    let auditResult = null;
    let repairs = 0;
    let iteration = 0;
    const trace = [];
    const requestStartTime = Date.now();
    const callCounts = new Map();
    const usageTotals = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let streamedAny = false;
    let nativeTools = agentConfig.engine?.native_tools === true;

    onEvent('start', {
      agentId,
      model: agentConfig.engine?.model,
      grounding: !!cfg.enabled,
      max_loops: maxLoops,
      skills: skillCtx.used
    });

    while (iteration < maxLoops) {
      if (circuitBreaker.isBroken(agentId)) break;

      const budgetState = budget.check(agentConfig.limits || {}, agentConfig.engine || {});
      if (!budgetState.allowed) {
        finalResponse = `${budgetState.reason} No further model calls were made this turn. Receipts: ${
          ledger.entries.length ? ledger.entries.map(e => e.id).join(', ') : 'none'
        }.`;
        onEvent('budget_blocked', budgetState);
        logger.error(agentId, 'BUDGET_BLOCKED', budgetState);
        break;
      }

      messages = this.compressContext(messages, agentConfig.engine?.context_budget || 14000);

      const systemContent = buildSystemPrompt(agentConfig, registry.getToolDescription(), {
        ledger,
        skillContext: skillCtx.text,
        nativeTools
      });
      if (messages[0] && messages[0].role === 'system') messages[0] = { role: 'system', content: systemContent };
      else messages.unshift({ role: 'system', content: systemContent });

      const estTokens = Math.floor(JSON.stringify(messages).length / 3.8);
      onEvent('telemetry', {
        ctx_used: estTokens,
        ctx_total: agentConfig.engine?.context_window || 32000,
        latency: Date.now() - requestStartTime,
        iteration: iteration + 1,
        max_iterations: maxLoops,
        receipts: ledger.entries.length,
        active_node: `MerlinCore #${iteration + 1}`
      });

      const llmStart = Date.now();
      let response = '';
      let nativeCalls = null;

      if (nativeTools) {
        try {
          const nativeRes = await llmManager.generateChat(messages, { tools: registry.getOpenAITools() });
          response = nativeRes.content || '';
          nativeCalls = nativeRes.tool_calls || null;
        } catch (err) {
          logger.warn(agentId, 'NATIVE_TOOLS_UNAVAILABLE', { error: err.message });
          onEvent('native_tools_unavailable', { error: err.message });
          nativeTools = false;
        }
      }

      if (!nativeTools && agentConfig.engine?.stream === true && typeof llmManager.stream === 'function') {
        try {
          let started = false;
          await llmManager.stream(messages, (delta) => {
            if (!delta) return;
            if (!started) {
              started = true;
              onEvent('draft_start', { model: agentConfig.engine?.model });
            }
            response += delta;
            onEvent('draft', { delta });
          });
          if (started) {
            streamedAny = true;
            onEvent('draft_end', { chars: response.length });
          }
        } catch (err) {
          logger.error(agentId, 'LLM_STREAM_ERROR', { error: err.message, chars: response.length });
          onEvent('draft_end', { chars: response.length, failed: true });
          // A partial stream is not trustworthy. Discard it and get a complete answer.
          response = '';
        }
      }

      if (!response && !(nativeCalls && nativeCalls.length)) {
        try {
          response = await llmManager.generate(messages);
        } catch (err) {
          logger.error(agentId, 'LLM_ERROR', { error: err.message });
          response = `Error: LLM provider unavailable (${err.message})`;
        }
      }
      const llmMs = Math.max(1, Date.now() - llmStart);
      const usage = typeof llmManager.getLastUsage === 'function' ? llmManager.getLastUsage() : null;
      if (usage) {
        usageTotals.prompt_tokens += Number(usage.prompt_tokens || 0);
        usageTotals.completion_tokens += Number(usage.completion_tokens || 0);
        usageTotals.total_tokens += Number(usage.total_tokens || 0);
        budget.record(usage, agentConfig.engine || {});
      }
      onEvent('telemetry', {
        // Measured, not invented: estimated output tokens / real wall time.
        tok_speed: parseFloat(((String(response).length / 4) / (llmMs / 1000)).toFixed(1)),
        latency_ms: llmMs,
        prompt_tokens: usage?.prompt_tokens ?? null,
        completion_tokens: usage?.completion_tokens ?? null
      });

      let reasoning = null;
      if (nativeCalls && nativeCalls.length) {
        if (response.trim()) reasoning = { content: response.trim(), kind: 'native' };
      } else {
        reasoning = this.extractReasoning(response);
      }
      if (reasoning) {
        trace.push({ type: 'thought', content: reasoning.content, kind: reasoning.kind });
        onEvent('thought', { content: reasoning.content, kind: reasoning.kind });
      }

      const explicitFinal = this.extractFinal(response);
      const hasNativeCalls = !!(nativeCalls && nativeCalls.length);
      const textToolCalls = explicitFinal === null && !hasNativeCalls ? this.parseToolCalls(response) : [];

      // ── Candidate answer: audit before delivery ──────────────────────────
      if (!hasNativeCalls && (explicitFinal !== null || textToolCalls.length === 0)) {
        const candidate = explicitFinal !== null ? explicitFinal : this.cleanAnswer(response);

        const verdict = cfg.enabled
          ? grounding.audit(candidate, ledger, {
              requireReadback: cfg.require_readback,
              requireCitations: cfg.require_citations
            })
          : { passed: true, status: 'DISABLED', violations: [], claims_checked: 0, receipts: ledger.entries.length, citations: [] };

        trace.push({ type: 'grounding', status: verdict.status, violations: verdict.violations.length, repairs });

        if (!verdict.passed && repairs < cfg.max_repairs) {
          repairs++;
          onEvent('grounding_audit', {
            status: 'repair',
            attempt: repairs,
            max_repairs: cfg.max_repairs,
            claims_checked: verdict.claims_checked,
            violations: verdict.violations
          });

          const repairMsg = grounding.buildRepairMessage(verdict, ledger, repairs, cfg.max_repairs);
          memory.add(agentId, 'assistant', response);
          memory.add(agentId, 'user', repairMsg);
          messages.push({ role: 'assistant', content: response });
          // Repair prompts are directives the model must act on. Some providers (e.g. kimi-k2.7)
          // silently ignore mid-conversation system messages, so deliver them as user turns.
          messages.push({ role: 'user', content: repairMsg });

          logger.warn(agentId, 'GROUNDING_REPAIR', { attempt: repairs, codes: verdict.violations.map(v => v.code) });
          circuitBreaker.increment(agentId);
          iteration++;
          continue;
        }

        auditResult = verdict;
        if (!verdict.passed) {
          finalResponse = grounding.annotate(candidate, verdict, ledger);
          onEvent('grounding_warning', {
            status: 'unverified',
            violations: verdict.violations,
            receipts: ledger.entries.length
          });
          logger.error(agentId, 'GROUNDING_UNVERIFIED', { codes: verdict.violations.map(v => v.code) });
        } else {
          finalResponse = candidate;
          onEvent('grounding_pass', {
            claims_checked: verdict.claims_checked,
            receipts: ledger.entries.length,
            citations: verdict.citations
          });
        }
        break;
      }

      // ── Tool execution ───────────────────────────────────────────────────
      const toolCalls = hasNativeCalls
        ? nativeCalls.map(tc => ({
            name: tc.function?.name,
            args: this.parseNativeArgs(tc.function?.arguments),
            id: tc.id || null,
            native: true
          }))
        : textToolCalls;

      memory.add(agentId, 'assistant', response || '[native tool calls]');
      if (hasNativeCalls) {
        messages.push({ role: 'assistant', content: response || null, tool_calls: nativeCalls });
      } else {
        messages.push({ role: 'assistant', content: response });
      }

      for (const call of toolCalls) {
        const callKey = `${call.name}:${JSON.stringify(call.args)}`;
        const repetitions = (callCounts.get(callKey) || 0) + 1;
        callCounts.set(callKey, repetitions);

        // Loop guard: a model that never consumes its receipt must be forced to answer.
        if (repetitions > 2) {
          const target = call.args.path || call.args.command || call.args.url || call.args.pattern || '';
          const prior = [...ledger.entries].reverse().find(
            e => e.tool === call.name && String(e.target || '') === String(target)
          );
          const nudge = [
            `DUPLICATE CALL SUPPRESSED: '${call.name}' was already executed with identical arguments` +
              (prior ? ` and returned receipt ${prior.id} (${prior.ok ? 'OK' : 'FAILED'})` : '') + '.',
            'Do not repeat it. Use the existing receipt and produce the final answer as [FINAL: ...],',
            'or state exactly what is still unverified (UNVERIFIED: ...).'
          ].join(' ');

          trace.push({ type: 'loop_guard', tool: call.name, receipt: prior ? prior.id : null });
          onEvent('loop_guard', { tool: call.name, receipt: prior ? prior.id : null, repetitions });
          memory.add(agentId, 'user', nudge);
          if (call.native && call.id) messages.push({ role: 'tool', tool_call_id: call.id, content: nudge });
          else messages.push({ role: 'user', content: nudge });
          continue;
        }

        const isSensitive = registry.isSensitive(call.name, call.args);

        trace.push({ type: 'tool', name: call.name, args: call.args, sensitive: isSensitive });
        onEvent('tool_dispatch', {
          tool: call.name,
          command: call.args.command || JSON.stringify(call.args),
          args: call.args,
          sensitive: isSensitive
        });

        let denied = false;
        if (isSensitive) {
          onEvent('hitl_intercept', {
            tool: call.name,
            target: call.args.command || call.args.path || JSON.stringify(call.args),
            reason: `Sensitive action (${call.name}) requires human authorization.`
          });
          const approved = await waitForHitl(agentId, call.name, call.args);
          if (!approved) denied = true;
          else onEvent('hitl_approved', { tool: call.name });
        }

        const toolStart = Date.now();
        let result;
        if (denied) {
          result = { error: `DENIED by the human operator. Tool '${call.name}' did not execute.` };
        } else {
          result = await registry.execute(call.name, call.args);
        }
        const durationMs = Date.now() - toolStart;

        const ev = ledger.record(call.name, call.args, result, { denied });
        const outStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

        onEvent('observation', {
          evidence: ev.id,
          tool: call.name,
          ok: ev.ok,
          output: outStr,
          exit_code: typeof result?.exit_code === 'number' ? result.exit_code : (ev.ok ? 0 : 1),
          duration_ms: durationMs,
          approved: !denied
        });

        const observation = `OBSERVATION [${ev.id}] ${call.name} ${ev.ok ? 'OK' : 'FAILED'}${ev.exit_code !== null ? ` (exit ${ev.exit_code})` : ''}: ${outStr}`;
        // Observations are tool results: deliver as user turns, never mid-conversation system
        // messages (several providers drop those silently and re-issue the same call forever).
        memory.add(agentId, 'user', observation);
        if (call.native && call.id) messages.push({ role: 'tool', tool_call_id: call.id, content: outStr });
        else messages.push({ role: 'user', content: observation });
      }

      circuitBreaker.increment(agentId);
      iteration++;
    }

    if (!finalResponse) {
      const pending = ledger.unresolvedPending();
      finalResponse = [
        `Execution limit reached (${iteration}/${maxLoops}) without a verified final answer.`,
        'No completion is claimed.',
        `Receipts: ${ledger.entries.length ? ledger.entries.map(e => e.id).join(', ') : 'none'}.`,
        pending.length ? `Changed but unverified: ${pending.map(p => p.path).join(', ')}.` : ''
      ].filter(Boolean).join(' ');
      logger.error(agentId, 'TURN_INCOMPLETE', { iteration, maxLoops });
    }

    memory.add(agentId, 'assistant', finalResponse);
    agentConfig.metrics = agentConfig.metrics || { requests: 0 };
    agentConfig.metrics.requests++;
    logger.info(agentId, 'TURN_COMPLETE', {
      durationMs: Date.now() - requestStartTime,
      grounded: auditResult ? auditResult.passed : null,
      repairs
    });

    const priceIn = Number(agentConfig.engine?.price_in_per_1k);
    const priceOut = Number(agentConfig.engine?.price_out_per_1k);
    const usageReport = (usageTotals.total_tokens > 0 || usageTotals.prompt_tokens > 0)
      ? {
          ...usageTotals,
          cost_estimate: Number.isFinite(priceIn) && Number.isFinite(priceOut)
            ? +((usageTotals.prompt_tokens / 1000) * priceIn + (usageTotals.completion_tokens / 1000) * priceOut).toFixed(6)
            : null
        }
      : null;

    const resultPayload = {
      success: true,
      response: finalResponse,
      grounded: auditResult ? auditResult.passed : null,
      usage: usageReport,
      streamed: streamedAny,
      native_tools: nativeTools,
      budget: budget.snapshot(),
      trace,
      durationMs: Date.now() - requestStartTime,
      iterations: iteration,
      repairs,
      grounding: {
        status: auditResult ? auditResult.status : 'INCOMPLETE',
        passed: auditResult ? auditResult.passed : null,
        claims_checked: auditResult ? auditResult.claims_checked : 0,
        violations: auditResult ? auditResult.violations : [],
        repairs,
        ledger: ledger.toJSON()
      }
    };

    onEvent('final', resultPayload);
    onEvent('done', { status: 'success' });
    return resultPayload;
  }
}

module.exports = new MerlinEngine();
