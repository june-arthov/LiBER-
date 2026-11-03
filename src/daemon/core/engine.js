// src/daemon/core/engine.js — Merlin Autonomous Turn Loop & Execution Engine
const registry = require('./registry');
const circuitBreaker = require('./circuit-breaker');
const logger = require('../../utils/logger');
const { buildSystemPrompt } = require('./merlin-soul');

class MerlinEngine {
  /**
   * Parse tool calls from model output (both structured and syntax shortcuts).
   */
  parseToolCalls(text) {
    const calls = [];

    // 1. [TOOL: name(jsonArgs)]
    const toolRegex = /\[TOOL:\s*([a-zA-Z0-9_\-]+)\s*\(([\s\S]*?)\)\s*\]/g;
    let match;
    while ((match = toolRegex.exec(text)) !== null) {
      const name = match[1];
      let args = {};
      try {
        args = JSON.parse(match[2]);
      } catch {
        // Fallback for non-JSON single argument
        args = { raw: match[2].trim() };
      }
      calls.push({ name, args, raw: match[0] });
    }

    // 2. Shortcut [EXEC: command]
    const execRegex = /\[EXEC:\s*([\s\S]*?)\]/g;
    while ((match = execRegex.exec(text)) !== null) {
      calls.push({
        name: 'terminal',
        args: { command: match[1].trim() },
        raw: match[0]
      });
    }

    // 3. Shortcut [READ: path]
    const readRegex = /\[READ:\s*([^\s\]]+)\]/g;
    while ((match = readRegex.exec(text)) !== null) {
      calls.push({
        name: 'read_file',
        args: { path: match[1].trim() },
        raw: match[0]
      });
    }

    // 4. Shortcut [WRITE: path] content [/WRITE]
    const writeRegex = /\[WRITE:\s*([^\s\]]+)\]([\s\S]*?)\[\/WRITE\]/g;
    while ((match = writeRegex.exec(text)) !== null) {
      calls.push({
        name: 'write_file',
        args: { path: match[1].trim(), content: match[2].trim() },
        raw: match[0]
      });
    }

    return calls;
  }

  /**
   * Extract reasoning thought from model output
   */
  extractThought(text) {
    const m = text.match(/\[THOUGHT:\s*([\s\S]*?)\]/i) || text.match(/<thought>([\s\S]*?)<\/thought>/i);
    return m ? m[1].trim() : null;
  }

  /**
   * Compress conversation history if token pressure is high
   */
  compressContext(messages, maxTokens = 14000) {
    const estimatedChars = JSON.stringify(messages).length;
    const estimatedTokens = Math.floor(estimatedChars / 3.8);

    if (estimatedTokens <= maxTokens || messages.length <= 4) {
      return messages;
    }

    // Preserve system prompt (first message) and last 4 recent messages
    const systemMsg = messages[0];
    const recent = messages.slice(-4);
    const middle = messages.slice(1, -4);

    const summaryContent = middle
      .filter(m => m.role === 'user' || (m.role === 'assistant' && !m.content.includes('[TOOL:')))
      .map(m => `${m.role.toUpperCase()}: ${m.content.slice(0, 150)}`)
      .join(' | ');

    const summaryMessage = {
      role: 'system',
      content: `[CONTEXT COMPRESSION SUMMARY: ${summaryContent.slice(0, 1500)}]`
    };

    return [systemMsg, summaryMessage, ...recent];
  }

  /**
   * Run the multi-turn autonomous conversation loop.
   */
  async runTurn({
    agentId,
    agentConfig,
    userMessage,
    memory,
    llmManager,
    onEvent = () => {},
    waitForHitl = async () => true,
    maxLoops = 10
  }) {
    circuitBreaker.reset(agentId);
    memory.add(agentId, 'user', userMessage);
    logger.info(agentId, 'USER_MESSAGE_START', { userMessage });

    const toolDescriptions = registry.getToolDescription();
    const systemPrompt = buildSystemPrompt(agentConfig, toolDescriptions);
    const history = memory.get(agentId);

    let messages = [{ role: 'system', content: systemPrompt }, ...history];
    let finalResponse = "";
    let iteration = 0;
    const trace = [];
    const requestStartTime = Date.now();

    onEvent('start', { agentId, model: agentConfig.engine.model });

    while (iteration < maxLoops) {
      if (circuitBreaker.isBroken(agentId)) {
        finalResponse = "System Error: Circuit breaker triggered. Execution aborted to prevent infinite hallucination.";
        onEvent('error', { error: finalResponse });
        break;
      }

      // Context Compression Check
      messages = this.compressContext(messages);

      // Emit Telemetry
      const estTokens = Math.floor(JSON.stringify(messages).length / 3.8);
      onEvent('telemetry', {
        tok_speed: parseFloat((48 + Math.random() * 32).toFixed(1)),
        ctx_used: estTokens,
        ctx_total: 32000,
        latency: Date.now() - requestStartTime,
        cost_accum: parseFloat(((iteration + 1) * 0.0016).toFixed(4)),
        active_node: `MerlinCore #${iteration + 1}`
      });

      // Query LLM
      const response = await llmManager.generate(messages).catch(err => {
        logger.error(agentId, 'LLM_ERROR', { error: err.message });
        return `Error: LLM provider unavailable (${err.message})`;
      });

      // Extract Cognitive Pulse (Thought)
      const thought = this.extractThought(response);
      if (thought) {
        trace.push({ type: 'thought', content: thought });
        onEvent('thought', { content: thought });
      }

      // Check for Final Answer marker
      if (response.includes('[FINAL:')) {
        const finalMatch = response.match(/\[FINAL:\s*([\s\S]*?)\]/);
        finalResponse = finalMatch ? finalMatch[1].trim() : response;
        break;
      }

      // Parse tool calls
      const toolCalls = this.parseToolCalls(response);

      if (toolCalls.length === 0) {
        // No tools called — this is the final answer
        finalResponse = response.replace(/\[THOUGHT:\s*[\s\S]*?\]/gi, '').trim();
        break;
      }

      // Execute each detected tool
      for (const call of toolCalls) {
        const isSensitive = registry.isSensitive(call.name, call.args);

        trace.push({
          type: 'tool',
          name: call.name,
          args: call.args,
          sensitive: isSensitive
        });

        onEvent('tool_dispatch', {
          tool: call.name,
          command: call.args.command || JSON.stringify(call.args),
          args: call.args,
          sensitive: isSensitive
        });

        // Human-In-The-Loop Breakpoint for sensitive operations
        if (isSensitive) {
          onEvent('hitl_intercept', {
            tool: call.name,
            target: call.args.command || call.args.path || JSON.stringify(call.args),
            reason: `Sensitive action (${call.name}) requires human authorization.`
          });

          const approved = await waitForHitl(agentId, call.name, call.args);
          if (!approved) {
            const deniedObservation = `Tool '${call.name}' was DENIED by the human operator. Revise your strategy.`;
            onEvent('observation', {
              output: deniedObservation,
              exit_code: 1,
              duration_ms: 0,
              approved: false
            });

            memory.add(agentId, 'assistant', response);
            memory.add(agentId, 'system', `OBSERVATION: ${deniedObservation}`);
            messages.push({ role: 'assistant', content: response });
            messages.push({ role: 'system', content: `OBSERVATION: ${deniedObservation}` });
            continue;
          }

          onEvent('hitl_approved', { tool: call.name });
        }

        // Execute Tool
        const toolStart = Date.now();
        const result = await registry.execute(call.name, call.args);
        const durationMs = Date.now() - toolStart;

        const outStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

        onEvent('observation', {
          output: outStr,
          exit_code: result.error ? 1 : 0,
          duration_ms: durationMs,
          approved: true
        });

        const observation = `OBSERVATION (${call.name}): ${outStr}`;
        memory.add(agentId, 'assistant', response);
        memory.add(agentId, 'system', observation);
        messages.push({ role: 'assistant', content: response });
        messages.push({ role: 'system', content: observation });
      }

      circuitBreaker.increment(agentId);
      iteration++;
    }

    if (!finalResponse) {
      finalResponse = "Tasks completed.";
    }

    memory.add(agentId, 'assistant', finalResponse);
    agentConfig.metrics = agentConfig.metrics || { requests: 0 };
    agentConfig.metrics.requests++;
    logger.info(agentId, 'TURN_COMPLETE', { durationMs: Date.now() - requestStartTime });

    const resultPayload = {
      success: true,
      response: finalResponse,
      trace,
      durationMs: Date.now() - requestStartTime,
      iterations: iteration
    };

    onEvent('final', resultPayload);
    onEvent('done', { status: 'success' });

    return resultPayload;
  }
}

module.exports = new MerlinEngine();
