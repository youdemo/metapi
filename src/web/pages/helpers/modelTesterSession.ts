export const MESSAGE_STATUS = {
  LOADING: 'loading',
  INCOMPLETE: 'incomplete',
  COMPLETE: 'complete',
  ERROR: 'error',
} as const;

export const DEBUG_TABS = {
  PREVIEW: 'preview',
  REQUEST: 'request',
  RESPONSE: 'response',
} as const;

type MessageStatus = typeof MESSAGE_STATUS[keyof typeof MESSAGE_STATUS];
export type DebugTab = typeof DEBUG_TABS[keyof typeof DEBUG_TABS];
type ChatRole = 'user' | 'assistant' | 'system';
export type TestTargetFormat = 'openai' | 'claude' | 'responses';

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createAt: number;
  status?: MessageStatus;
  reasoningContent?: string | null;
  isReasoningExpanded?: boolean;
  isThinkingComplete?: boolean;
  hasAutoCollapsed?: boolean;
};

type ApiChatMessage = {
  role: ChatRole;
  content: string;
};

export type ModelTesterInputs = {
  model: string;
  targetFormat: TestTargetFormat;
  temperature: number;
  top_p: number;
  max_tokens: number;
  frequency_penalty: number;
  presence_penalty: number;
  seed: number | null;
  stream: boolean;
};

export type ParameterEnabled = {
  temperature: boolean;
  top_p: boolean;
  max_tokens: boolean;
  frequency_penalty: boolean;
  presence_penalty: boolean;
  seed: boolean;
};

export type TestChatPayload = {
  model: string;
  messages: ApiChatMessage[];
  targetFormat?: TestTargetFormat;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number;
};

export type ModelTesterSessionState = {
  input: string;
  inputs: ModelTesterInputs;
  parameterEnabled: ParameterEnabled;
  messages: ChatMessage[];
  pendingPayload: TestChatPayload | null;
  pendingJobId?: string | null;
  customRequestMode: boolean;
  customRequestBody: string;
  showDebugPanel: boolean;
  activeDebugTab: DebugTab;
};

export const MODEL_TESTER_STORAGE_KEY = 'metapi:model-tester:session:v4';

export const DEFAULT_INPUTS: ModelTesterInputs = {
  model: '',
  targetFormat: 'openai',
  temperature: 0.7,
  top_p: 1,
  max_tokens: 4096,
  frequency_penalty: 0,
  presence_penalty: 0,
  seed: null,
  stream: false,
};

export const DEFAULT_PARAMETER_ENABLED: ParameterEnabled = {
  temperature: true,
  top_p: false,
  max_tokens: false,
  frequency_penalty: true,
  presence_penalty: true,
  seed: false,
};

const THINK_TAG_REGEX = /<think>([\s\S]*?)<\/think>/g;
const VALID_ROLES: ReadonlySet<string> = new Set(['user', 'assistant', 'system']);
const VALID_STATUS: ReadonlySet<string> = new Set(Object.values(MESSAGE_STATUS));
const VALID_DEBUG_TABS: ReadonlySet<string> = new Set(Object.values(DEBUG_TABS));

let messageCounter = 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const toFiniteNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const toBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const toNullableFiniteNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
};

const isExactModelPattern = (modelPattern: string): boolean => {
  const normalized = modelPattern.trim();
  if (!normalized) return false;
  if (normalized.toLowerCase().startsWith('re:')) return false;
  return !/[\*\?\[]/.test(normalized);
};

export const collectModelTesterModelNames = (
  marketplace: { models?: Array<{ name?: unknown }>; } | null | undefined,
  routes: Array<{ modelPattern?: unknown; enabled?: unknown; }> | null | undefined,
): string[] => {
  const result: string[] = [];
  const seen = new Set<string>();

  const appendModel = (rawName: unknown) => {
    if (typeof rawName !== 'string') return;
    const name = rawName.trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    result.push(name);
  };

  for (const item of marketplace?.models || []) {
    appendModel(item?.name);
  }

  for (const route of routes || []) {
    if (!route || route.enabled === false) continue;
    if (typeof route.modelPattern !== 'string') continue;
    const modelPattern = route.modelPattern.trim();
    if (!modelPattern || !isExactModelPattern(modelPattern)) continue;
    appendModel(modelPattern);
  }

  return result;
};

export const filterModelTesterModelNames = (models: string[], query: string): string[] => {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return [...models];

  return models
    .map((name, index) => {
      const matchIndex = name.toLowerCase().indexOf(keyword);
      if (matchIndex === -1) return null;
      return { name, matchIndex, index };
    })
    .filter((item): item is { name: string; matchIndex: number; index: number } => item !== null)
    .sort((a, b) => {
      if (a.matchIndex !== b.matchIndex) return a.matchIndex - b.matchIndex;
      if (a.name.length !== b.name.length) return a.name.length - b.name.length;
      return a.index - b.index;
    })
    .map((item) => item.name);
};

const createMessageId = (): string => {
  messageCounter += 1;
  return `msg-${Date.now()}-${messageCounter}`;
};

export const createMessage = (role: ChatRole, content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: createMessageId(),
  role,
  content,
  createAt: Date.now(),
  ...extra,
});

export const createLoadingAssistantMessage = (): ChatMessage =>
  createMessage('assistant', '', {
    status: MESSAGE_STATUS.LOADING,
    reasoningContent: '',
    isReasoningExpanded: true,
    isThinkingComplete: false,
    hasAutoCollapsed: false,
  });

const parseMessage = (value: unknown, index: number): ChatMessage | null => {
  if (!isRecord(value)) return null;
  if (typeof value.role !== 'string' || !VALID_ROLES.has(value.role)) return null;
  if (typeof value.content !== 'string') return null;

  const parsed: ChatMessage = {
    id: typeof value.id === 'string' && value.id.trim().length > 0
      ? value.id
      : `legacy-${index}-${Date.now()}`,
    role: value.role as ChatRole,
    content: value.content,
    createAt: typeof value.createAt === 'number' && Number.isFinite(value.createAt)
      ? value.createAt
      : Date.now(),
  };

  if (typeof value.status === 'string' && VALID_STATUS.has(value.status)) {
    parsed.status = value.status as MessageStatus;
  }
  if (typeof value.reasoningContent === 'string') {
    parsed.reasoningContent = value.reasoningContent;
  } else if (value.reasoningContent === null) {
    parsed.reasoningContent = null;
  }
  if (typeof value.isReasoningExpanded === 'boolean') {
    parsed.isReasoningExpanded = value.isReasoningExpanded;
  }
  if (typeof value.isThinkingComplete === 'boolean') {
    parsed.isThinkingComplete = value.isThinkingComplete;
  }
  if (typeof value.hasAutoCollapsed === 'boolean') {
    parsed.hasAutoCollapsed = value.hasAutoCollapsed;
  }

  return parsed;
};

const sanitizeMessages = (value: unknown): ChatMessage[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => parseMessage(item, index))
    .filter((item): item is ChatMessage => item !== null);
};

const parseInputs = (value: unknown, fallbackModel = ''): ModelTesterInputs => {
  if (!isRecord(value)) {
    return {
      ...DEFAULT_INPUTS,
      model: fallbackModel,
    };
  }

  const model = typeof value.model === 'string' && value.model.trim().length > 0
    ? value.model
    : fallbackModel;

  return {
    model,
    targetFormat: value.targetFormat === 'claude'
      ? 'claude'
      : value.targetFormat === 'responses'
        ? 'responses'
        : DEFAULT_INPUTS.targetFormat,
    temperature: toFiniteNumber(value.temperature, DEFAULT_INPUTS.temperature),
    top_p: toFiniteNumber(value.top_p, DEFAULT_INPUTS.top_p),
    max_tokens: toFiniteNumber(value.max_tokens, DEFAULT_INPUTS.max_tokens),
    frequency_penalty: toFiniteNumber(value.frequency_penalty, DEFAULT_INPUTS.frequency_penalty),
    presence_penalty: toFiniteNumber(value.presence_penalty, DEFAULT_INPUTS.presence_penalty),
    seed: toNullableFiniteNumber(value.seed),
    stream: toBoolean(value.stream, DEFAULT_INPUTS.stream),
  };
};

const parseParameterEnabled = (value: unknown): ParameterEnabled => {
  if (!isRecord(value)) {
    return { ...DEFAULT_PARAMETER_ENABLED };
  }

  return {
    temperature: toBoolean(value.temperature, DEFAULT_PARAMETER_ENABLED.temperature),
    top_p: toBoolean(value.top_p, DEFAULT_PARAMETER_ENABLED.top_p),
    max_tokens: toBoolean(value.max_tokens, DEFAULT_PARAMETER_ENABLED.max_tokens),
    frequency_penalty: toBoolean(value.frequency_penalty, DEFAULT_PARAMETER_ENABLED.frequency_penalty),
    presence_penalty: toBoolean(value.presence_penalty, DEFAULT_PARAMETER_ENABLED.presence_penalty),
    seed: toBoolean(value.seed, DEFAULT_PARAMETER_ENABLED.seed),
  };
};

const parsePendingPayload = (value: unknown): TestChatPayload | null => {
  if (!isRecord(value)) return null;
  if (typeof value.model !== 'string' || value.model.trim().length === 0) return null;

  const payloadMessages = sanitizeMessages(value.messages).map((message) => ({
    role: message.role,
    content: message.content,
  }));

  if (payloadMessages.length === 0) return null;

  const payload: TestChatPayload = {
    model: value.model,
    messages: payloadMessages,
  };

  if (value.targetFormat === 'claude' || value.targetFormat === 'openai' || value.targetFormat === 'responses') {
    payload.targetFormat = value.targetFormat;
  }
  if (typeof value.stream === 'boolean') payload.stream = value.stream;
  if (typeof value.temperature === 'number' && Number.isFinite(value.temperature)) payload.temperature = value.temperature;
  if (typeof value.top_p === 'number' && Number.isFinite(value.top_p)) payload.top_p = value.top_p;
  if (typeof value.max_tokens === 'number' && Number.isFinite(value.max_tokens)) payload.max_tokens = value.max_tokens;
  if (typeof value.frequency_penalty === 'number' && Number.isFinite(value.frequency_penalty)) payload.frequency_penalty = value.frequency_penalty;
  if (typeof value.presence_penalty === 'number' && Number.isFinite(value.presence_penalty)) payload.presence_penalty = value.presence_penalty;
  if (typeof value.seed === 'number' && Number.isFinite(value.seed)) payload.seed = value.seed;

  return payload;
};

export const serializeModelTesterSession = (state: ModelTesterSessionState): string =>
  JSON.stringify(state);

export const processThinkTags = (content: string, reasoningContent = ''): { content: string; reasoningContent: string } => {
  if (!content || !content.includes('<think>')) {
    return { content, reasoningContent };
  }

  const thoughts: string[] = [];
  const replyParts: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  THINK_TAG_REGEX.lastIndex = 0;
  while ((match = THINK_TAG_REGEX.exec(content)) !== null) {
    replyParts.push(content.substring(lastIndex, match.index));
    thoughts.push(match[1]);
    lastIndex = match.index + match[0].length;
  }
  replyParts.push(content.substring(lastIndex));

  const processedContent = replyParts.join('').replace(/<\/?think>/g, '').trim();
  const thoughtsCombined = thoughts.join('\n\n---\n\n');

  return {
    content: processedContent,
    reasoningContent: reasoningContent && thoughtsCombined
      ? `${reasoningContent}\n\n---\n\n${thoughtsCombined}`
      : (reasoningContent || thoughtsCombined),
  };
};

const processIncompleteThinkTags = (content: string, reasoningContent = ''): { content: string; reasoningContent: string } => {
  if (!content) return { content: '', reasoningContent };

  const lastOpenThinkIndex = content.lastIndexOf('<think>');
  if (lastOpenThinkIndex === -1) {
    return processThinkTags(content, reasoningContent);
  }

  const fragmentAfterLastOpen = content.substring(lastOpenThinkIndex);
  if (!fragmentAfterLastOpen.includes('</think>')) {
    const unclosedThought = fragmentAfterLastOpen.substring('<think>'.length).trim();
    const cleanContent = content.substring(0, lastOpenThinkIndex);
    const mergedReasoning = unclosedThought
      ? (reasoningContent ? `${reasoningContent}\n\n---\n\n${unclosedThought}` : unclosedThought)
      : reasoningContent;
    return processThinkTags(cleanContent, mergedReasoning);
  }

  return processThinkTags(content, reasoningContent);
};

export const finalizeIncompleteMessage = (message: ChatMessage): ChatMessage => {
  if (message.status !== MESSAGE_STATUS.LOADING && message.status !== MESSAGE_STATUS.INCOMPLETE) {
    return message;
  }

  const processed = processIncompleteThinkTags(message.content || '', message.reasoningContent || '');
  return {
    ...message,
    content: processed.content || message.content,
    reasoningContent: processed.reasoningContent || null,
    status: MESSAGE_STATUS.COMPLETE,
    isThinkingComplete: true,
  };
};

const buildFallbackInputsFromLegacy = (value: Record<string, unknown>): ModelTesterInputs => {
  const legacyModel = typeof value.model === 'string' ? value.model : '';
  const inputs = parseInputs(value.inputs, legacyModel);

  if (!value.inputs) {
    inputs.targetFormat = value.targetFormat === 'claude'
      ? 'claude'
      : value.targetFormat === 'responses'
        ? 'responses'
        : inputs.targetFormat;
    inputs.temperature = toFiniteNumber(value.temperature, inputs.temperature);
  }

  return inputs;
};

export const parseModelTesterSession = (raw: string | null): ModelTesterSessionState | null => {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;

  const inputs = buildFallbackInputsFromLegacy(parsed);
  if (!inputs.model) return null;

  const state: ModelTesterSessionState = {
    input: typeof parsed.input === 'string' ? parsed.input : '',
    inputs,
    parameterEnabled: parseParameterEnabled(parsed.parameterEnabled),
    messages: sanitizeMessages(parsed.messages),
    pendingPayload: parsePendingPayload(parsed.pendingPayload),
    customRequestMode: toBoolean(parsed.customRequestMode, false),
    customRequestBody: typeof parsed.customRequestBody === 'string' ? parsed.customRequestBody : '',
    showDebugPanel: toBoolean(parsed.showDebugPanel, false),
    activeDebugTab: typeof parsed.activeDebugTab === 'string' && VALID_DEBUG_TABS.has(parsed.activeDebugTab)
      ? parsed.activeDebugTab as DebugTab
      : DEBUG_TABS.PREVIEW,
  };

  if (typeof parsed.pendingJobId === 'string' && parsed.pendingJobId.trim().length > 0) {
    state.pendingJobId = parsed.pendingJobId;
  } else if (parsed.pendingJobId === null) {
    state.pendingJobId = null;
  }

  if (!state.pendingJobId && state.messages.length > 0) {
    state.messages = state.messages.map((message) => finalizeIncompleteMessage(message));
  }

  return state;
};

export const toApiMessages = (messages: ChatMessage[]): ApiChatMessage[] =>
  messages
    .filter((message) => {
      if (message.role !== 'assistant') return true;
      return message.status !== MESSAGE_STATUS.LOADING && message.status !== MESSAGE_STATUS.INCOMPLETE;
    })
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));

export const buildApiPayload = (
  messages: ChatMessage[],
  inputs: ModelTesterInputs,
  parameterEnabled: ParameterEnabled,
): TestChatPayload => {
  const payload: TestChatPayload = {
    model: inputs.model,
    messages: toApiMessages(messages),
    targetFormat: inputs.targetFormat,
    stream: inputs.stream,
  };

  const mapping: Array<{ key: keyof ParameterEnabled; field: keyof ModelTesterInputs }> = [
    { key: 'temperature', field: 'temperature' },
    { key: 'top_p', field: 'top_p' },
    { key: 'max_tokens', field: 'max_tokens' },
    { key: 'frequency_penalty', field: 'frequency_penalty' },
    { key: 'presence_penalty', field: 'presence_penalty' },
    { key: 'seed', field: 'seed' },
  ];

  for (const item of mapping) {
    const enabled = parameterEnabled[item.key];
    if (!enabled) continue;

    const value = inputs[item.field];
    if (item.field === 'seed') {
      if (typeof value === 'number' && Number.isFinite(value)) {
        payload.seed = value;
      }
      continue;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      (payload as any)[item.field] = value;
    }
  }

  return payload;
};

export const parseCustomRequestBody = (raw: string): TestChatPayload | null => {
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsePendingPayload(parsed);
  } catch {
    return null;
  }
};

export const syncMessagesToCustomRequestBody = (
  currentBody: string,
  messages: ChatMessage[],
  inputs: ModelTesterInputs,
): string => {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(currentBody || '{}');
  } catch {
    payload = {};
  }

  payload.model = typeof payload.model === 'string' && payload.model.trim().length > 0
    ? payload.model
    : inputs.model;
  payload.targetFormat = payload.targetFormat === 'claude'
    ? 'claude'
    : payload.targetFormat === 'responses'
      ? 'responses'
      : inputs.targetFormat;
  payload.stream = payload.stream !== undefined ? payload.stream : inputs.stream;
  payload.messages = toApiMessages(messages);

  return JSON.stringify(payload, null, 2);
};

export const syncCustomRequestBodyToMessages = (raw: string): ChatMessage[] | null => {
  const parsed = parseCustomRequestBody(raw);
  if (!parsed?.messages || parsed.messages.length === 0) return null;

  return parsed.messages.map((item, index) => createMessage(item.role, item.content, {
    id: `custom-${index}-${Date.now()}`,
  }));
};

export const findLastLoadingAssistantIndex = (messages: ChatMessage[]): number => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message.role === 'assistant' &&
      (message.status === MESSAGE_STATUS.LOADING || message.status === MESSAGE_STATUS.INCOMPLETE)
    ) {
      return index;
    }
  }
  return -1;
};

export const countConversationTurns = (messages: ChatMessage[]): number =>
  messages.reduce((turns, message) => turns + (message.role === 'user' ? 1 : 0), 0);
