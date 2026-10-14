import { StringDecoder } from 'string_decoder';

export const MAX_ATTEMPTS = 1;
export const DEFAULT_RETRY_DELAY_MS = 500;
export const MAX_429_RETRY_AFTER_MS = 5000;
export const REQUEST_TOTAL_DEADLINE_MS = 120000;
export const MAX_PRECOMMIT_BYTES = 1024 * 1024; // 1 MiB

export function isRequestRetryEligible(parsedBody) {
  if (!parsedBody) return true;

  if (Array.isArray(parsedBody.tools) && parsedBody.tools.length > 0) {
    for (const tool of parsedBody.tools) {
      if (!tool || tool.type !== 'function') {
        return false;
      }
    }
  }

  return true;
}

/**
 * 构造 Attempt 3 的 Healing Payload
 */
export function buildHealingPayload(parsedBody) {
  if (!parsedBody || !Array.isArray(parsedBody.messages) || parsedBody.messages.length === 0) {
    return null;
  }
  const cloned = JSON.parse(JSON.stringify(parsedBody));
  const messages = cloned.messages;
  const lastMsg = messages[messages.length - 1];

  let lastStr = '';
  if (typeof lastMsg.content === 'string') {
    lastStr = lastMsg.content;
  } else if (Array.isArray(lastMsg.content)) {
    const textParts = lastMsg.content
      .filter(p => p && p.type === 'text' && typeof p.text === 'string')
      .map(p => p.text);
    lastStr = textParts.join(' ');
  }

  let hintText = '';
  if (lastMsg.role === 'user' && (lastStr.includes('<system-reminder>') || lastStr.includes('system-reminder'))) {
    hintText = 'Continue from the previous tool result and take the next concrete action. Do not return an empty response.';
  } else {
    hintText = 'Continue the current task and produce the next concrete action. Do not return an empty response.';
  }

  if (lastMsg.role === 'user') {
    if (typeof lastMsg.content === 'string') {
      lastMsg.content = lastMsg.content + '\n\n' + hintText;
    } else if (Array.isArray(lastMsg.content)) {
      lastMsg.content.push({ type: 'text', text: hintText });
    } else {
      lastMsg.content = hintText;
    }
  } else {
    messages.push({
      role: 'user',
      content: hintText
    });
  }

  return Buffer.from(JSON.stringify(cloned), 'utf8');
}

/**
 * 提取语义完成状态
 */
export function extractSemanticStatus(choice) {
  if (!choice) return { hasSemantic: false, hasReasoning: false, isExplicitFinish: false, finishReason: null };

  const delta = choice.delta || choice.message;
  const finishReason = choice.finish_reason || choice.native_finish_reason || null;

  let hasSemantic = false;
  let hasReasoning = false;

  if (delta) {
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      hasSemantic = true;
    }
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      hasReasoning = true;
    }
    if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) {
      hasReasoning = true;
    }
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      for (const tc of delta.tool_calls) {
        if (tc.id || tc.type) hasSemantic = true;
        if (tc.function && (tc.function.name || (typeof tc.function.arguments === 'string' && tc.function.arguments.length > 0))) {
          hasSemantic = true;
        }
      }
    }
    if (delta.function_call && (delta.function_call.name || delta.function_call.arguments)) {
      hasSemantic = true;
    }
  }

  const normalStops = ['stop', 'length', 'tool_calls', 'function_call'];
  let isExplicitFinish = false;
  if (finishReason && !normalStops.includes(finishReason)) {
    isExplicitFinish = true;
  }

  return { hasSemantic, hasReasoning, isExplicitFinish, finishReason };
}

export class SseStreamParser {
  constructor(onEvent) {
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.isFirstChunk = true;
    this.pendingCR = false;
    this.onEvent = onEvent;
    this.isIncompleteEof = false;
  }

  feed(chunk) {
    let str = this.decoder.write(chunk);
    if (this.isFirstChunk) {
      if (str.charCodeAt(0) === 0xFEFF) {
        str = str.slice(1);
      }
      this.isFirstChunk = false;
    }

    if (str.length === 0) return;

    let normalized = '';
    let i = 0;

    if (this.pendingCR) {
      this.pendingCR = false;
      if (str.charCodeAt(0) === 10) {
        normalized += '\n';
        i = 1;
      } else {
        normalized += '\n';
      }
    }

    const len = str.length;
    while (i < len) {
      const code = str.charCodeAt(i);
      if (code === 13) {
        if (i + 1 < len) {
          if (str.charCodeAt(i + 1) === 10) {
            normalized += '\n';
            i += 2;
          } else {
            normalized += '\n';
            i += 1;
          }
        } else {
          this.pendingCR = true;
          i += 1;
        }
      } else {
        normalized += str[i];
        i += 1;
      }
    }

    this.buffer += normalized;
    this.processBuffer();
  }

  flush() {
    let trailing = this.decoder.end();
    if (this.pendingCR) {
      this.pendingCR = false;
      trailing = '\n' + trailing;
    }

    if (trailing.length > 0) {
      this.buffer += trailing.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    }
    this.processBuffer();

    if (this.buffer.trim().length > 0) {
      this.isIncompleteEof = true;
      this.buffer = '';
    }
  }

  processBuffer() {
    let delimiterIndex;
    while ((delimiterIndex = this.buffer.indexOf('\n\n')) !== -1) {
      const eventBlock = this.buffer.slice(0, delimiterIndex);
      this.buffer = this.buffer.slice(delimiterIndex + 2);
      this.parseEventBlock(eventBlock);
    }
  }

  parseEventBlock(block) {
    const lines = block.split('\n');
    const dataLines = [];
    let eventName = null;

    for (const line of lines) {
      if (line.startsWith(':')) {
        continue;
      }
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (dataLines.length > 0) {
      const combinedData = dataLines.join('\n');
      this.onEvent(eventName, combinedData);
    }
  }
}

export function parseRetryAfterMs(headers) {
  const retryHeader = headers['retry-after'];
  if (!retryHeader) return DEFAULT_RETRY_DELAY_MS;

  const seconds = parseInt(retryHeader, 10);
  if (!isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(retryHeader);
  if (!isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : DEFAULT_RETRY_DELAY_MS;
  }

  return DEFAULT_RETRY_DELAY_MS;
}

export function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error('Aborted'));
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    function onAbort() {
      cleanup();
      reject(new Error('Aborted'));
    }

    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
