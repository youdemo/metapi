import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fetch } from 'undici';
import { db, schema } from '../../db/index.js';
import { tokenRouter } from '../../services/tokenRouter.js';
import { refreshModelsAndRebuildRoutes } from '../../services/modelService.js';
import { reportProxyAllFailed, reportTokenExpired } from '../../services/alertService.js';
import { isTokenExpiredError } from '../../services/alertRules.js';
import { estimateProxyCost } from '../../services/modelPricingService.js';
import { shouldRetryProxyRequest } from '../../services/proxyRetryPolicy.js';
import { resolveProxyUsageWithSelfLogFallback } from '../../services/proxyUsageFallbackService.js';
import { mergeProxyUsage, parseProxyUsage } from '../../services/proxyUsageParser.js';
import { withExplicitProxyRequestInit } from '../../services/siteProxy.js';
import {
  createStreamTransformContext,
  normalizeUpstreamFinalResponse,
  normalizeUpstreamStreamEvent,
  pullSseEventsWithDone,
  type NormalizedStreamEvent,
} from './chatFormats.js';
import {
  buildUpstreamEndpointRequest,
  isEndpointDowngradeError,
  resolveUpstreamEndpointCandidates,
  type UpstreamEndpoint,
} from './upstreamEndpoint.js';
import { ensureModelAllowedForDownstreamKey, getDownstreamRoutingPolicy, recordDownstreamCostUsage } from './downstreamPolicy.js';

const MAX_RETRIES = 2;

function withUpstreamPath(path: string, message: string): string {
  return `[upstream:${path}] ${message}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function normalizeText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeText(item))
      .filter((item) => item.length > 0)
      .join('\n');
  }
  if (isRecord(value)) {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (typeof value.input_text === 'string') return value.input_text;
    if (typeof value.output_text === 'string') return value.output_text;
    if (Array.isArray(value.content)) return normalizeText(value.content);
  }
  return '';
}

function convertResponsesBodyToOpenAiBody(
  body: Record<string, unknown>,
  modelName: string,
  stream: boolean,
): Record<string, unknown> {
  const messages: Array<{ role: string; content: string }> = [];
  const input = body.input;

  if (typeof input === 'string') {
    const text = input.trim();
    if (text) messages.push({ role: 'user', content: text });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!isRecord(item)) continue;
      const role = typeof item.role === 'string' ? item.role : 'user';
      const text = normalizeText(item.content ?? item).trim();
      if (!text) continue;
      messages.push({ role: role === 'assistant' ? 'assistant' : (role === 'system' ? 'system' : 'user'), content: text });
    }
  } else if (isRecord(input)) {
    const text = normalizeText(input).trim();
    if (text) messages.push({ role: 'user', content: text });
  }

  const instructions = typeof body.instructions === 'string' ? body.instructions.trim() : '';
  if (instructions) {
    messages.unshift({ role: 'system', content: instructions });
  }

  const payload: Record<string, unknown> = {
    model: modelName,
    stream,
    messages,
  };

  if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) {
    payload.temperature = body.temperature;
  }
  if (typeof body.top_p === 'number' && Number.isFinite(body.top_p)) {
    payload.top_p = body.top_p;
  }
  if (typeof body.max_output_tokens === 'number' && Number.isFinite(body.max_output_tokens)) {
    payload.max_tokens = body.max_output_tokens;
  }
  if (body.tools !== undefined) payload.tools = body.tools;
  if (body.tool_choice !== undefined) payload.tool_choice = body.tool_choice;

  return payload;
}

type UsageSummary = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

type ResponsesToolCall = {
  id: string;
  name: string;
  arguments: string;
};

type ResponsesMessageItemState = {
  itemId: string;
  outputIndex: number;
  contentIndex: number;
  text: string;
};

type ResponsesToolItemState = {
  toolIndex: number;
  itemId: string;
  callId: string;
  outputIndex: number;
  name: string;
  arguments: string;
};

type ResponsesStreamState = {
  started: boolean;
  completed: boolean;
  responseId: string;
  model: string;
  createdAt: number;
  sequenceNumber: number;
  outputCursor: number;
  messageItem: ResponsesMessageItemState | null;
  toolItems: Map<number, ResponsesToolItemState>;
};

function ensureResponseId(rawId: string): string {
  const trimmed = rawId.trim() || `resp_${Date.now()}`;
  return trimmed.startsWith('resp_') ? trimmed : `resp_${trimmed}`;
}

function ensureMessageId(rawId: string): string {
  const trimmed = rawId.trim() || `msg_${Date.now()}`;
  return trimmed.startsWith('msg_') ? trimmed : `msg_${trimmed}`;
}

function ensureFunctionCallId(rawId: string): string {
  const trimmed = rawId.trim();
  if (!trimmed) return `call_${Date.now()}`;
  return trimmed.startsWith('call_') ? trimmed : `call_${trimmed}`;
}

function stringifyToolInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
}

function extractToolCallsFromUpstream(payload: unknown): ResponsesToolCall[] {
  if (!isRecord(payload)) return [];

  if (Array.isArray(payload.choices)) {
    const choice = payload.choices[0];
    const message = isRecord((choice as any)?.message) ? (choice as any).message : {};
    const toolCalls = Array.isArray((message as any).tool_calls) ? (message as any).tool_calls : [];
    return toolCalls
      .map((item: unknown, index: number) => {
        if (!isRecord(item)) return null;
        const fn = isRecord(item.function) ? item.function : {};
        const id = typeof item.id === 'string' && item.id.trim().length > 0
          ? item.id
          : `call_${index}`;
        const name = typeof fn.name === 'string' ? fn.name : '';
        const args = typeof fn.arguments === 'string' ? fn.arguments : '';
        return {
          id: ensureFunctionCallId(id),
          name,
          arguments: args,
        };
      })
      .filter((item: ResponsesToolCall | null): item is ResponsesToolCall => !!item);
  }

  if (payload.type === 'message' && Array.isArray(payload.content)) {
    return payload.content
      .map((item: unknown, index: number) => {
        if (!isRecord(item) || item.type !== 'tool_use') return null;
        const id = typeof item.id === 'string' && item.id.trim().length > 0
          ? item.id
          : `call_${index}`;
        const name = typeof item.name === 'string' ? item.name : '';
        const args = stringifyToolInput(item.input);
        return {
          id: ensureFunctionCallId(id),
          name,
          arguments: args,
        };
      })
      .filter((item: ResponsesToolCall | null): item is ResponsesToolCall => !!item);
  }

  return [];
}

function toResponsesPayload(
  upstreamPayload: unknown,
  normalized: ReturnType<typeof normalizeUpstreamFinalResponse>,
  usage: UsageSummary,
): Record<string, unknown> {
  if (isRecord(upstreamPayload) && upstreamPayload.object === 'response') {
    return upstreamPayload;
  }

  const normalizedId = typeof normalized.id === 'string' && normalized.id.trim()
    ? normalized.id.trim()
    : `resp_${Date.now()}`;
  const responseId = ensureResponseId(normalizedId);
  const messageId = ensureMessageId(normalizedId);
  const toolCalls = extractToolCallsFromUpstream(upstreamPayload);

  const output: Array<Record<string, unknown>> = [];
  if (normalized.content || toolCalls.length === 0) {
    output.push({
      id: messageId,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{
        type: 'output_text',
        text: normalized.content || '',
      }],
    });
  }

  for (const toolCall of toolCalls) {
    output.push({
      id: toolCall.id,
      type: 'function_call',
      status: 'completed',
      call_id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
    });
  }

  return {
    id: responseId,
    object: 'response',
    created: normalized.created,
    status: 'completed',
    model: normalized.model,
    output,
    output_text: normalized.content || '',
    usage: {
      input_tokens: usage.promptTokens,
      output_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
    },
  };
}

function createResponsesStreamState(modelName: string): ResponsesStreamState {
  return {
    started: false,
    completed: false,
    responseId: `resp_meta_${Date.now()}`,
    model: modelName,
    createdAt: Math.floor(Date.now() / 1000),
    sequenceNumber: 0,
    outputCursor: 0,
    messageItem: null,
    toolItems: new Map(),
  };
}

function toResponsesUsage(usage: UsageSummary): Record<string, number> {
  return {
    input_tokens: usage.promptTokens,
    output_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
  };
}

function nextSequence(state: ResponsesStreamState): number {
  const value = state.sequenceNumber;
  state.sequenceNumber += 1;
  return value;
}

function serializeResponsesSse(eventType: string, payload: Record<string, unknown>): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function emitResponsesEvent(
  state: ResponsesStreamState,
  eventType: string,
  payload: Record<string, unknown>,
): string {
  return serializeResponsesSse(eventType, {
    type: eventType,
    sequence_number: nextSequence(state),
    ...payload,
  });
}

function buildResponseObject(
  state: ResponsesStreamState,
  status: 'in_progress' | 'completed',
  usage?: UsageSummary,
): Record<string, unknown> {
  const response: Record<string, unknown> = {
    id: state.responseId,
    object: 'response',
    created_at: state.createdAt,
    status,
    model: state.model,
    output: [],
  };
  if (usage) {
    response.usage = toResponsesUsage(usage);
  }
  return response;
}

function ensureResponsesStarted(
  state: ResponsesStreamState,
  streamContext: { id: string; model: string; created: number },
): string[] {
  if (state.started) return [];

  state.started = true;
  state.responseId = ensureResponseId(streamContext.id || state.responseId);
  state.model = streamContext.model || state.model;
  state.createdAt = streamContext.created || state.createdAt;

  const inProgress = buildResponseObject(state, 'in_progress');
  return [
    emitResponsesEvent(state, 'response.created', { response: inProgress }),
    emitResponsesEvent(state, 'response.in_progress', { response: inProgress }),
  ];
}

function ensureMessageItem(state: ResponsesStreamState): string[] {
  if (state.messageItem) return [];

  const outputIndex = state.outputCursor;
  state.outputCursor += 1;
  const itemId = ensureMessageId(`${state.responseId}_${outputIndex}`);
  state.messageItem = {
    itemId,
    outputIndex,
    contentIndex: 0,
    text: '',
  };

  return [
    emitResponsesEvent(state, 'response.output_item.added', {
      output_index: outputIndex,
      item: {
        id: itemId,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    }),
    emitResponsesEvent(state, 'response.content_part.added', {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: {
        type: 'output_text',
        text: '',
      },
    }),
  ];
}

function appendMessageDelta(state: ResponsesStreamState, delta: string): string[] {
  if (!delta) return [];

  const events: string[] = [];
  events.push(...ensureMessageItem(state));
  if (!state.messageItem) return events;

  state.messageItem.text += delta;
  events.push(emitResponsesEvent(state, 'response.output_text.delta', {
    item_id: state.messageItem.itemId,
    output_index: state.messageItem.outputIndex,
    content_index: state.messageItem.contentIndex,
    delta,
  }));
  return events;
}

function closeMessageItem(state: ResponsesStreamState): string[] {
  if (!state.messageItem) return [];

  const item = state.messageItem;
  const events = [
    emitResponsesEvent(state, 'response.output_text.done', {
      item_id: item.itemId,
      output_index: item.outputIndex,
      content_index: item.contentIndex,
      text: item.text,
    }),
    emitResponsesEvent(state, 'response.content_part.done', {
      item_id: item.itemId,
      output_index: item.outputIndex,
      content_index: item.contentIndex,
      part: {
        type: 'output_text',
        text: item.text,
      },
    }),
    emitResponsesEvent(state, 'response.output_item.done', {
      output_index: item.outputIndex,
      item: {
        id: item.itemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{
          type: 'output_text',
          text: item.text,
        }],
      },
    }),
  ];

  state.messageItem = null;
  return events;
}

function ensureToolItem(
  state: ResponsesStreamState,
  toolIndex: number,
  id?: string,
  name?: string,
): string[] {
  const existing = state.toolItems.get(toolIndex);
  if (existing) {
    if (id && !existing.callId) existing.callId = ensureFunctionCallId(id);
    if (id && !existing.itemId) existing.itemId = ensureFunctionCallId(id);
    if (name && !existing.name) existing.name = name;
    return [];
  }

  const outputIndex = state.outputCursor;
  state.outputCursor += 1;
  const callId = ensureFunctionCallId(id || `${state.responseId}_${toolIndex}`);
  const itemId = callId;
  const toolState: ResponsesToolItemState = {
    toolIndex,
    itemId,
    callId,
    outputIndex,
    name: name || '',
    arguments: '',
  };
  state.toolItems.set(toolIndex, toolState);

  return [
    emitResponsesEvent(state, 'response.output_item.added', {
      output_index: outputIndex,
      item: {
        id: itemId,
        type: 'function_call',
        status: 'in_progress',
        call_id: callId,
        name: toolState.name,
        arguments: '',
      },
    }),
  ];
}

function appendToolCallDelta(
  state: ResponsesStreamState,
  toolDelta: NonNullable<NormalizedStreamEvent['toolCallDeltas']>[number],
): string[] {
  const toolIndex = Number.isFinite(toolDelta.index) ? Math.max(0, Math.trunc(toolDelta.index)) : 0;
  const events: string[] = [];
  events.push(...ensureToolItem(state, toolIndex, toolDelta.id, toolDelta.name));

  const toolState = state.toolItems.get(toolIndex);
  if (!toolState) return events;
  if (toolDelta.name && !toolState.name) toolState.name = toolDelta.name;

  if (toolDelta.argumentsDelta !== undefined) {
    toolState.arguments += toolDelta.argumentsDelta;
    events.push(emitResponsesEvent(state, 'response.function_call_arguments.delta', {
      item_id: toolState.itemId,
      output_index: toolState.outputIndex,
      delta: toolDelta.argumentsDelta,
    }));
  }

  return events;
}

function closeToolItems(state: ResponsesStreamState): string[] {
  if (state.toolItems.size <= 0) return [];

  const ordered = Array.from(state.toolItems.values())
    .sort((a, b) => a.outputIndex - b.outputIndex);
  const events: string[] = [];
  for (const toolItem of ordered) {
    events.push(emitResponsesEvent(state, 'response.function_call_arguments.done', {
      item_id: toolItem.itemId,
      output_index: toolItem.outputIndex,
      arguments: toolItem.arguments,
    }));
    events.push(emitResponsesEvent(state, 'response.output_item.done', {
      output_index: toolItem.outputIndex,
      item: {
        id: toolItem.itemId,
        type: 'function_call',
        status: 'completed',
        call_id: toolItem.callId,
        name: toolItem.name,
        arguments: toolItem.arguments,
      },
    }));
  }

  state.toolItems.clear();
  return events;
}

function completeResponsesStream(
  state: ResponsesStreamState,
  streamContext: { id: string; model: string; created: number },
  usage: UsageSummary,
): string[] {
  if (state.completed) return [];

  const events: string[] = [];
  events.push(...ensureResponsesStarted(state, streamContext));
  events.push(...closeMessageItem(state));
  events.push(...closeToolItems(state));
  events.push(emitResponsesEvent(state, 'response.completed', {
    response: buildResponseObject(state, 'completed', usage),
  }));
  events.push('data: [DONE]\n\n');
  state.completed = true;
  return events;
}

function serializeConvertedResponsesEvents(input: {
  state: ResponsesStreamState;
  streamContext: { id: string; model: string; created: number };
  event: NormalizedStreamEvent;
  usage: UsageSummary;
}): string[] {
  const { state, streamContext, event, usage } = input;
  if (state.completed) return [];

  const shouldStart = (
    event.role === 'assistant'
    || !!event.contentDelta
    || !!event.reasoningDelta
    || (Array.isArray(event.toolCallDeltas) && event.toolCallDeltas.length > 0)
    || !!event.done
    || !!event.finishReason
  );

  const events: string[] = [];
  if (shouldStart) {
    events.push(...ensureResponsesStarted(state, streamContext));
  }

  if (event.contentDelta) {
    events.push(...appendMessageDelta(state, event.contentDelta));
  }
  if (event.reasoningDelta) {
    events.push(...appendMessageDelta(state, event.reasoningDelta));
  }

  if (Array.isArray(event.toolCallDeltas) && event.toolCallDeltas.length > 0) {
    events.push(...closeMessageItem(state));
    for (const toolDelta of event.toolCallDeltas) {
      events.push(...appendToolCallDelta(state, toolDelta));
    }
  }

  if (event.finishReason) {
    // Keep compatibility with clients that expect finish before completed.
  }

  if (event.done) {
    events.push(...completeResponsesStream(state, streamContext, usage));
  }

  return events;
}

export async function responsesProxyRoute(app: FastifyInstance) {
  app.post('/v1/responses', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    const requestedModel = typeof body?.model === 'string' ? body.model.trim() : '';
    if (!requestedModel) {
      return reply.code(400).send({ error: { message: 'model is required', type: 'invalid_request_error' } });
    }
    if (!ensureModelAllowedForDownstreamKey(request, reply, requestedModel)) return;
    const downstreamPolicy = getDownstreamRoutingPolicy(request);

    const isStream = body.stream === true;
    const excludeChannelIds: number[] = [];
    let retryCount = 0;

    while (retryCount <= MAX_RETRIES) {
      let selected = retryCount === 0
        ? tokenRouter.selectChannel(requestedModel, downstreamPolicy)
        : tokenRouter.selectNextChannel(requestedModel, excludeChannelIds, downstreamPolicy);

      if (!selected && retryCount === 0) {
        await refreshModelsAndRebuildRoutes();
        selected = tokenRouter.selectChannel(requestedModel, downstreamPolicy);
      }

      if (!selected) {
        await reportProxyAllFailed({
          model: requestedModel,
          reason: 'No available channels after retries',
        });
        return reply.code(503).send({
          error: { message: 'No available channels for this model', type: 'server_error' },
        });
      }

      excludeChannelIds.push(selected.channel.id);

      const modelName = selected.actualModel || requestedModel;
      const openAiBody = convertResponsesBodyToOpenAiBody(body, modelName, isStream);
      const endpointCandidates = await resolveUpstreamEndpointCandidates(
        {
          site: selected.site,
          account: selected.account,
        },
        modelName,
        'responses',
      );
      if (endpointCandidates.length === 0) {
        endpointCandidates.push('responses', 'chat', 'messages');
      }

      const startTime = Date.now();

      try {
        let upstream: Awaited<ReturnType<typeof fetch>> | null = null;
        let successfulUpstreamPath: string | null = null;
        let finalStatus = 0;
        let finalErrText = 'unknown error';

        for (let endpointIndex = 0; endpointIndex < endpointCandidates.length; endpointIndex += 1) {
          const endpoint = endpointCandidates[endpointIndex] as UpstreamEndpoint;
          const endpointRequest = buildUpstreamEndpointRequest({
            endpoint,
            modelName,
            stream: isStream,
            tokenValue: selected.tokenValue,
            sitePlatform: selected.site.platform,
            siteUrl: selected.site.url,
            openaiBody: openAiBody,
            downstreamFormat: 'responses',
            responsesOriginalBody: body,
            downstreamHeaders: request.headers as Record<string, unknown>,
          });
          const targetUrl = `${selected.site.url}${endpointRequest.path}`;

          const response = await fetch(targetUrl, withExplicitProxyRequestInit(selected.site.proxyUrl, {
            method: 'POST',
            headers: endpointRequest.headers,
            body: JSON.stringify(endpointRequest.body),
          }));

          if (response.ok) {
            upstream = response;
            successfulUpstreamPath = endpointRequest.path;
            break;
          }

          const rawErrText = await response.text().catch(() => 'unknown error');
          const errText = withUpstreamPath(endpointRequest.path, rawErrText);
          const shouldDowngradeEndpoint = (
            endpointIndex < endpointCandidates.length - 1
            && isEndpointDowngradeError(response.status, rawErrText)
          );

          if (shouldDowngradeEndpoint) {
            logProxy(selected, requestedModel, 'failed', response.status, Date.now() - startTime, errText, retryCount);
            continue;
          }

          finalStatus = response.status;
          finalErrText = errText;
          break;
        }

        if (!upstream) {
          const status = finalStatus || 502;
          const errText = finalErrText || 'unknown error';
          tokenRouter.recordFailure(selected.channel.id);
          logProxy(selected, requestedModel, 'failed', status, Date.now() - startTime, errText, retryCount);

          if (isTokenExpiredError({ status, message: errText })) {
            await reportTokenExpired({
              accountId: selected.account.id,
              username: selected.account.username,
              siteName: selected.site.name,
              detail: `HTTP ${status}`,
            });
          }

          if (shouldRetryProxyRequest(status, errText) && retryCount < MAX_RETRIES) {
            retryCount += 1;
            continue;
          }

          await reportProxyAllFailed({
            model: requestedModel,
            reason: `upstream returned HTTP ${status}`,
          });
          return reply.code(status).send({ error: { message: errText, type: 'upstream_error' } });
        }

        if (isStream) {
          reply.raw.statusCode = 200;
          reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
          reply.raw.setHeader('Connection', 'keep-alive');
          reply.raw.setHeader('X-Accel-Buffering', 'no');

          const reader = upstream.body?.getReader();
          if (!reader) {
            reply.raw.end();
            return;
          }

          const decoder = new TextDecoder();
          let parsedUsage: UsageSummary = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
          let sseBuffer = '';

          const passthroughResponsesStream = successfulUpstreamPath === '/v1/responses';
          const streamContext = createStreamTransformContext(modelName);
          const responsesState = createResponsesStreamState(modelName);

          const writeLines = (lines: string[]) => {
            for (const line of lines) reply.raw.write(line);
          };

          const consumeSseBuffer = (incoming: string): string => {
            const pulled = pullSseEventsWithDone(incoming);
            for (const eventBlock of pulled.events) {
              if (eventBlock.data === '[DONE]') {
                if (passthroughResponsesStream) {
                  reply.raw.write('data: [DONE]\n\n');
                } else {
                  writeLines(completeResponsesStream(responsesState, streamContext, parsedUsage));
                }
                continue;
              }

              let parsedPayload: unknown = null;
              try {
                parsedPayload = JSON.parse(eventBlock.data);
              } catch {
                parsedPayload = null;
              }

              if (parsedPayload && typeof parsedPayload === 'object') {
                parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(parsedPayload));
              }

              if (passthroughResponsesStream) {
                const eventName = eventBlock.event ? `event: ${eventBlock.event}\n` : '';
                reply.raw.write(`${eventName}data: ${eventBlock.data}\n\n`);
                continue;
              }

              if (parsedPayload && typeof parsedPayload === 'object') {
                const normalizedEvent = normalizeUpstreamStreamEvent(parsedPayload, streamContext, modelName);
                writeLines(serializeConvertedResponsesEvents({
                  state: responsesState,
                  streamContext,
                  event: normalizedEvent,
                  usage: parsedUsage,
                }));
                continue;
              }

              writeLines(serializeConvertedResponsesEvents({
                state: responsesState,
                streamContext,
                event: { contentDelta: eventBlock.data },
                usage: parsedUsage,
              }));
            }

            return pulled.rest;
          };

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!value) continue;

              sseBuffer += decoder.decode(value, { stream: true });
              sseBuffer = consumeSseBuffer(sseBuffer);
            }

            sseBuffer += decoder.decode();
            if (sseBuffer.trim().length > 0) {
              sseBuffer = consumeSseBuffer(`${sseBuffer}\n\n`);
            }
          } finally {
            reader.releaseLock();
            if (!passthroughResponsesStream) {
              writeLines(completeResponsesStream(responsesState, streamContext, parsedUsage));
            }
            reply.raw.end();
          }

          const latency = Date.now() - startTime;
          const resolvedUsage = await resolveProxyUsageWithSelfLogFallback({
            site: selected.site,
            account: selected.account,
            tokenValue: selected.tokenValue,
            tokenName: selected.tokenName,
            modelName: selected.actualModel || requestedModel,
            requestStartedAtMs: startTime,
            requestEndedAtMs: startTime + latency,
            localLatencyMs: latency,
            usage: {
              promptTokens: parsedUsage.promptTokens,
              completionTokens: parsedUsage.completionTokens,
              totalTokens: parsedUsage.totalTokens,
            },
          });
          let estimatedCost = await estimateProxyCost({
            site: selected.site,
            account: selected.account,
            modelName: selected.actualModel || requestedModel,
            promptTokens: resolvedUsage.promptTokens,
            completionTokens: resolvedUsage.completionTokens,
            totalTokens: resolvedUsage.totalTokens,
          });
          if (resolvedUsage.estimatedCostFromQuota > 0 && (resolvedUsage.recoveredFromSelfLog || estimatedCost <= 0)) {
            estimatedCost = resolvedUsage.estimatedCostFromQuota;
          }
          tokenRouter.recordSuccess(selected.channel.id, latency, estimatedCost);
          recordDownstreamCostUsage(request, estimatedCost);
          logProxy(
            selected, requestedModel, 'success', 200, latency, null, retryCount,
            resolvedUsage.promptTokens, resolvedUsage.completionTokens, resolvedUsage.totalTokens, estimatedCost,
            successfulUpstreamPath,
          );
          return;
        }

        const rawText = await upstream.text();
        let upstreamData: unknown = rawText;
        try {
          upstreamData = JSON.parse(rawText);
        } catch {
          upstreamData = rawText;
        }
        const latency = Date.now() - startTime;
        const parsedUsage = parseProxyUsage(upstreamData);
        const normalized = normalizeUpstreamFinalResponse(
          upstreamData,
          modelName,
          rawText,
        );
        const downstreamData = toResponsesPayload(upstreamData, normalized, parsedUsage);
        const resolvedUsage = await resolveProxyUsageWithSelfLogFallback({
          site: selected.site,
          account: selected.account,
          tokenValue: selected.tokenValue,
          tokenName: selected.tokenName,
          modelName: selected.actualModel || requestedModel,
          requestStartedAtMs: startTime,
          requestEndedAtMs: startTime + latency,
          localLatencyMs: latency,
          usage: {
            promptTokens: parsedUsage.promptTokens,
            completionTokens: parsedUsage.completionTokens,
            totalTokens: parsedUsage.totalTokens,
          },
        });
        let estimatedCost = await estimateProxyCost({
          site: selected.site,
          account: selected.account,
          modelName: selected.actualModel || requestedModel,
          promptTokens: resolvedUsage.promptTokens,
          completionTokens: resolvedUsage.completionTokens,
          totalTokens: resolvedUsage.totalTokens,
        });
        if (resolvedUsage.estimatedCostFromQuota > 0 && (resolvedUsage.recoveredFromSelfLog || estimatedCost <= 0)) {
          estimatedCost = resolvedUsage.estimatedCostFromQuota;
        }

        tokenRouter.recordSuccess(selected.channel.id, latency, estimatedCost);
        recordDownstreamCostUsage(request, estimatedCost);
        logProxy(
          selected, requestedModel, 'success', 200, latency, null, retryCount,
          resolvedUsage.promptTokens, resolvedUsage.completionTokens, resolvedUsage.totalTokens, estimatedCost,
          successfulUpstreamPath,
        );
        return reply.send(downstreamData);
      } catch (err: any) {
        tokenRouter.recordFailure(selected.channel.id);
        logProxy(selected, requestedModel, 'failed', 0, Date.now() - startTime, err.message, retryCount);
        if (retryCount < MAX_RETRIES) {
          retryCount += 1;
          continue;
        }
        await reportProxyAllFailed({
          model: requestedModel,
          reason: err.message || 'network failure',
        });
        return reply.code(502).send({
          error: { message: `Upstream error: ${err.message}`, type: 'upstream_error' },
        });
      }
    }
  });
}

function logProxy(
  selected: any,
  modelRequested: string,
  status: string,
  httpStatus: number,
  latencyMs: number,
  errorMessage: string | null,
  retryCount: number,
  promptTokens = 0,
  completionTokens = 0,
  totalTokens = 0,
  estimatedCost = 0,
  upstreamPath: string | null = null,
) {
  try {
    const normalizedErrorMessage = errorMessage
      || (upstreamPath ? `[upstream:${upstreamPath}]` : null);
    db.insert(schema.proxyLogs).values({
      routeId: selected.channel.routeId,
      channelId: selected.channel.id,
      accountId: selected.account.id,
      modelRequested,
      modelActual: selected.actualModel,
      status,
      httpStatus,
      latencyMs,
      promptTokens,
      completionTokens,
      totalTokens,
      estimatedCost,
      errorMessage: normalizedErrorMessage,
      retryCount,
    }).run();
  } catch {}
}
