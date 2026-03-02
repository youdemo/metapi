import { fetchModelPricingCatalog } from '../../services/modelPricingService.js';
import type { DownstreamFormat } from './chatFormats.js';

export type UpstreamEndpoint = 'chat' | 'messages' | 'responses';
export type EndpointPreference = DownstreamFormat | 'responses';

type ChannelContext = {
  site: {
    id: number;
    url: string;
    platform: string;
    apiKey?: string | null;
  };
  account: {
    id: number;
    accessToken?: string | null;
    apiToken?: string | null;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePlatformName(platform: unknown): string {
  return asTrimmedString(platform).toLowerCase();
}

function headerValueToString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (trimmed) return trimmed;
    }
  }

  return null;
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const BLOCKED_PASSTHROUGH_HEADERS = new Set([
  'host',
  'content-length',
  'accept-encoding',
  'cookie',
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
]);

function shouldSkipPassthroughHeader(key: string): boolean {
  return HOP_BY_HOP_HEADERS.has(key) || BLOCKED_PASSTHROUGH_HEADERS.has(key);
}

function extractSafePassthroughHeaders(
  headers?: Record<string, unknown>,
): Record<string, string> {
  if (!headers) return {};

  const forwarded: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    if (!key || shouldSkipPassthroughHeader(key)) continue;

    const value = headerValueToString(rawValue);
    if (!value) continue;
    forwarded[key] = value;
  }

  return forwarded;
}

function extractClaudePassthroughHeaders(
  headers?: Record<string, unknown>,
): Record<string, string> {
  if (!headers) return {};

  const forwarded: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    const shouldForward = (
      key.startsWith('anthropic-')
      || key.startsWith('x-claude-')
      || key.startsWith('x-stainless-')
    );
    if (!shouldForward) continue;

    const value = headerValueToString(rawValue);
    if (!value) continue;
    forwarded[key] = value;
  }

  return forwarded;
}

function extractResponsesPassthroughHeaders(
  headers?: Record<string, unknown>,
): Record<string, string> {
  if (!headers) return {};

  const forwarded: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    const shouldForward = (
      key.startsWith('openai-')
      || key.startsWith('x-openai-')
      || key.startsWith('x-stainless-')
      || key.startsWith('chatgpt-')
      || key === 'originator'
    );
    if (!shouldForward) continue;

    const value = headerValueToString(rawValue);
    if (!value) continue;
    forwarded[key] = value;
  }

  return forwarded;
}

function ensureStreamAcceptHeader(
  headers: Record<string, string>,
  stream: boolean,
): Record<string, string> {
  if (!stream) return headers;

  const existingAccept = (
    headerValueToString(headers.accept)
    || headerValueToString((headers as Record<string, unknown>).Accept)
  );
  if (existingAccept) return headers;

  return {
    ...headers,
    accept: 'text/event-stream',
  };
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sanitizeMessagesBodyForAnthropic(body: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...body };
  const hasTemperature = toFiniteNumber(sanitized.temperature) !== null;
  const hasTopP = toFiniteNumber(sanitized.top_p) !== null;
  // Some Anthropic-compatible upstreams reject requests carrying both fields.
  if (hasTemperature && hasTopP) {
    delete sanitized.top_p;
  }

  // Claude Code may send thinking.type = "adaptive". Many Anthropic-compatible
  // upstreams only accept enabled/disabled.
  const thinking = sanitized.thinking;
  if (isRecord(thinking)) {
    const rawType = asTrimmedString(thinking.type).toLowerCase();
    if (rawType === 'adaptive') {
      const budgetTokens = toFiniteNumber(thinking.budget_tokens);
      if (budgetTokens !== null && budgetTokens > 0) {
        sanitized.thinking = {
          ...thinking,
          type: 'enabled',
          budget_tokens: Math.trunc(budgetTokens),
        };
      } else {
        sanitized.thinking = { type: 'disabled' };
      }
    } else if (rawType && rawType !== 'enabled' && rawType !== 'disabled') {
      sanitized.thinking = { type: 'disabled' };
    }
  }

  return sanitized;
}

function normalizeContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!isRecord(item)) return '';
        const text = asTrimmedString(item.text ?? item.content ?? item.output_text);
        return text;
      })
      .filter((item) => item.length > 0)
      .join('\n');
  }
  if (isRecord(content)) {
    const text = asTrimmedString(content.text ?? content.content ?? content.output_text);
    return text;
  }
  return '';
}

function convertOpenAiBodyToMessagesBody(
  openaiBody: Record<string, unknown>,
  modelName: string,
  stream: boolean,
): Record<string, unknown> {
  const rawMessages = Array.isArray(openaiBody.messages) ? openaiBody.messages : [];
  const systemContents: string[] = [];
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  for (const item of rawMessages) {
    if (!isRecord(item)) continue;
    const role = asTrimmedString(item.role) || 'user';
    const content = normalizeContentText(item.content);
    if (!content) continue;

    if (role === 'system') {
      systemContents.push(content);
      continue;
    }

    messages.push({
      role: role === 'assistant' ? 'assistant' : 'user',
      content,
    });
  }

  const body: Record<string, unknown> = {
    model: modelName,
    stream,
    messages,
    max_tokens: toFiniteNumber(openaiBody.max_tokens) ?? 4096,
  };

  if (systemContents.length > 0) {
    body.system = systemContents.join('\n\n');
  }

  const temperature = toFiniteNumber(openaiBody.temperature);
  if (temperature !== null) body.temperature = temperature;

  const topP = toFiniteNumber(openaiBody.top_p);
  if (topP !== null) body.top_p = topP;

  if (Array.isArray(openaiBody.stop) && openaiBody.stop.length > 0) {
    body.stop_sequences = openaiBody.stop;
  }

  if (openaiBody.tools !== undefined) body.tools = openaiBody.tools;
  if (openaiBody.tool_choice !== undefined) body.tool_choice = openaiBody.tool_choice;
  return body;
}

function convertOpenAiBodyToResponsesBody(
  openaiBody: Record<string, unknown>,
  modelName: string,
  stream: boolean,
): Record<string, unknown> {
  const rawMessages = Array.isArray(openaiBody.messages) ? openaiBody.messages : [];
  const systemContents: string[] = [];
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  for (const item of rawMessages) {
    if (!isRecord(item)) continue;
    const role = asTrimmedString(item.role) || 'user';
    const content = normalizeContentText(item.content);
    if (!content) continue;

    if (role === 'system') {
      systemContents.push(content);
      continue;
    }

    messages.push({
      role: role === 'assistant' ? 'assistant' : 'user',
      content,
    });
  }

  const body: Record<string, unknown> = {
    model: modelName,
    stream,
    max_output_tokens: toFiniteNumber(openaiBody.max_tokens) ?? 4096,
  };

  if (messages.length === 1 && messages[0].role === 'user' && systemContents.length === 0) {
    body.input = messages[0].content;
  } else {
    body.input = messages;
    if (systemContents.length > 0) {
      body.instructions = systemContents.join('\n\n');
    }
  }

  const temperature = toFiniteNumber(openaiBody.temperature);
  if (temperature !== null) body.temperature = temperature;

  const topP = toFiniteNumber(openaiBody.top_p);
  if (topP !== null) body.top_p = topP;

  if (openaiBody.tools !== undefined) body.tools = openaiBody.tools;
  if (openaiBody.tool_choice !== undefined) body.tool_choice = openaiBody.tool_choice;
  return body;
}

function normalizeEndpointTypes(value: unknown): UpstreamEndpoint[] {
  const raw = asTrimmedString(value).toLowerCase();
  if (!raw) return [];

  const normalized = new Set<UpstreamEndpoint>();

  if (
    raw.includes('/v1/messages')
    || raw === 'messages'
    || raw.includes('anthropic')
    || raw.includes('claude')
  ) {
    normalized.add('messages');
  }

  if (
    raw.includes('/v1/responses')
    || raw === 'responses'
    || raw.includes('response')
  ) {
    normalized.add('responses');
  }

  if (
    raw.includes('/v1/chat/completions')
    || raw.includes('chat/completions')
    || raw === 'chat'
    || raw === 'chat_completions'
    || raw === 'completions'
    || raw.includes('chat')
  ) {
    normalized.add('chat');
  }

  // Some upstreams return protocol families instead of concrete endpoint paths.
  if (raw === 'openai' || raw.includes('openai')) {
    normalized.add('chat');
    normalized.add('responses');
  }

  return Array.from(normalized);
}

function preferredEndpointOrder(downstreamFormat: EndpointPreference, sitePlatform?: string): UpstreamEndpoint[] {
  const platform = normalizePlatformName(sitePlatform);

  if (platform === 'gemini') {
    // Gemini upstream is routed through OpenAI-compatible chat endpoint.
    return ['chat'];
  }

  if (platform === 'openai') {
    return downstreamFormat === 'responses'
      ? ['responses', 'chat']
      : ['chat', 'responses'];
  }

  if (platform === 'claude') {
    return ['messages'];
  }

  if (downstreamFormat === 'responses') {
    return ['responses', 'chat', 'messages'];
  }

  return downstreamFormat === 'claude'
    ? ['messages', 'chat']
    : ['chat', 'messages'];
}

export async function resolveUpstreamEndpointCandidates(
  context: ChannelContext,
  modelName: string,
  downstreamFormat: EndpointPreference,
): Promise<UpstreamEndpoint[]> {
  const sitePlatform = normalizePlatformName(context.site.platform);
  if (sitePlatform === 'anyrouter') {
    // anyrouter deployments are effectively anthropic-protocol first.
    return downstreamFormat === 'responses'
      ? ['responses', 'messages', 'chat']
      : ['messages', 'chat'];
  }

  const preferred = preferredEndpointOrder(downstreamFormat, context.site.platform);

  try {
    const catalog = await fetchModelPricingCatalog({
      site: {
        id: context.site.id,
        url: context.site.url,
        platform: context.site.platform,
        apiKey: context.site.apiKey ?? null,
      },
      account: {
        id: context.account.id,
        accessToken: context.account.accessToken ?? null,
        apiToken: context.account.apiToken ?? null,
      },
      modelName,
      totalTokens: 0,
    });

    if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) {
      return preferred;
    }

    const matched = catalog.models.find((item) =>
      asTrimmedString(item?.modelName).toLowerCase() === modelName.toLowerCase(),
    );
    if (!matched) return preferred;

    const supportedRaw = Array.isArray(matched.supportedEndpointTypes) ? matched.supportedEndpointTypes : [];
    const supported = new Set<UpstreamEndpoint>();
    for (const endpoint of supportedRaw) {
      const normalizedList = normalizeEndpointTypes(endpoint);
      for (const normalized of normalizedList) {
        supported.add(normalized);
      }
    }

    if (supported.size === 0) return preferred;

    const filtered = preferred.filter((endpoint) => supported.has(endpoint));
    if (filtered.length === 0) return preferred;

    // Keep non-catalog endpoints as best-effort fallbacks because some
    // upstreams expose incomplete/incorrect endpoint metadata.
    const fallback = preferred.filter((endpoint) => !filtered.includes(endpoint));
    return [...filtered, ...fallback];
  } catch {
    return preferred;
  }
}

export function buildUpstreamEndpointRequest(input: {
  endpoint: UpstreamEndpoint;
  modelName: string;
  stream: boolean;
  tokenValue: string;
  sitePlatform?: string;
  siteUrl?: string;
  openaiBody: Record<string, unknown>;
  downstreamFormat: EndpointPreference;
  claudeOriginalBody?: Record<string, unknown>;
  responsesOriginalBody?: Record<string, unknown>;
  downstreamHeaders?: Record<string, unknown>;
}): {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const sitePlatform = normalizePlatformName(input.sitePlatform);
  const isClaudeUpstream = sitePlatform === 'claude';

  const resolveGeminiEndpointPath = (endpoint: UpstreamEndpoint): string => {
    const normalizedSiteUrl = asTrimmedString(input.siteUrl).toLowerCase();
    const openAiCompatBase = /\/openai(?:\/|$)/.test(normalizedSiteUrl);
    if (openAiCompatBase) {
      return endpoint === 'responses'
        ? '/responses'
        : '/chat/completions';
    }
    return endpoint === 'responses'
      ? '/v1beta/openai/responses'
      : '/v1beta/openai/chat/completions';
  };

  const resolveEndpointPath = (endpoint: UpstreamEndpoint): string => {
    if (sitePlatform === 'gemini') {
      return resolveGeminiEndpointPath(endpoint);
    }

    if (sitePlatform === 'openai') {
      if (endpoint === 'responses') return '/v1/responses';
      return '/v1/chat/completions';
    }

    if (sitePlatform === 'claude') {
      return '/v1/messages';
    }

    if (endpoint === 'messages') return '/v1/messages';
    if (endpoint === 'responses') return '/v1/responses';
    return '/v1/chat/completions';
  };

  const passthroughHeaders = extractSafePassthroughHeaders(input.downstreamHeaders);
  const commonHeaders: Record<string, string> = {
    ...passthroughHeaders,
    'Content-Type': 'application/json',
  };
  if (!isClaudeUpstream) {
    commonHeaders.Authorization = `Bearer ${input.tokenValue}`;
  }

  if (input.endpoint === 'messages') {
    const claudeHeaders = input.downstreamFormat === 'claude'
      ? extractClaudePassthroughHeaders(input.downstreamHeaders)
      : {};
    const anthropicVersion = (
      claudeHeaders['anthropic-version']
      || passthroughHeaders['anthropic-version']
      || '2023-06-01'
    );
    const body = (
      input.downstreamFormat === 'claude' && input.claudeOriginalBody
        ? {
          ...input.claudeOriginalBody,
          model: input.modelName,
          stream: input.stream,
        }
        : convertOpenAiBodyToMessagesBody(input.openaiBody, input.modelName, input.stream)
    );
    const sanitizedBody = sanitizeMessagesBodyForAnthropic(body);

    const headers = ensureStreamAcceptHeader({
      ...commonHeaders,
      ...claudeHeaders,
      'x-api-key': input.tokenValue,
      'anthropic-version': anthropicVersion,
    }, input.stream);

    return {
      path: resolveEndpointPath('messages'),
      headers,
      body: sanitizedBody,
    };
  }

  if (input.endpoint === 'responses') {
    const responsesHeaders = input.downstreamFormat === 'responses'
      ? extractResponsesPassthroughHeaders(input.downstreamHeaders)
      : {};
    const body = (
      input.downstreamFormat === 'responses' && input.responsesOriginalBody
        ? {
          ...input.responsesOriginalBody,
          model: input.modelName,
          stream: input.stream,
        }
        : convertOpenAiBodyToResponsesBody(input.openaiBody, input.modelName, input.stream)
    );

    const headers = ensureStreamAcceptHeader({
      ...commonHeaders,
      ...responsesHeaders,
    }, input.stream);

    return {
      path: resolveEndpointPath('responses'),
      headers,
      body,
    };
  }

  const headers = ensureStreamAcceptHeader(commonHeaders, input.stream);
  return {
    path: resolveEndpointPath('chat'),
    headers,
    body: {
      ...input.openaiBody,
      model: input.modelName,
      stream: input.stream,
    },
  };
}

export function isEndpointDowngradeError(status: number, upstreamErrorText?: string | null): boolean {
  if (status < 400) return false;
  const text = (upstreamErrorText || '').toLowerCase();
  if (!text) return false;

  let parsedCode = '';
  let parsedType = '';
  let parsedMessage = '';
  try {
    const parsed = JSON.parse(upstreamErrorText || '{}') as Record<string, unknown>;
    const error = (parsed.error && typeof parsed.error === 'object')
      ? parsed.error as Record<string, unknown>
      : parsed;
    parsedCode = asTrimmedString(error.code).toLowerCase();
    parsedType = asTrimmedString(error.type).toLowerCase();
    parsedMessage = asTrimmedString(error.message).toLowerCase();
  } catch {
    parsedCode = '';
    parsedType = '';
    parsedMessage = '';
  }

  return (
    text.includes('convert_request_failed')
    || text.includes('not implemented')
    || text.includes('api not implemented')
    || text.includes('unsupported legacy protocol')
    || parsedCode === 'convert_request_failed'
    || parsedCode === 'bad_response_status_code'
    || parsedType === 'bad_response_status_code'
    || parsedMessage.includes('bad_response_status_code')
  );
}
