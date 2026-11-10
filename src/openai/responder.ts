import OpenAI from 'openai';
import { readChatText, type MessageRow } from '../agentmeet/types.js';
import {
  clampText,
  fitTranscript,
  MAX_MESSAGE_CHARS,
  renderSpeakerLine,
  speakerLabel,
  TRANSCRIPT_NOTE,
} from '../transcript.js';

export interface TranscriptTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly author: string;
}

export interface BuildPromptInput {
  readonly history: readonly MessageRow[];
  readonly selfAgentId: string | null;
  readonly windowSize?: number;
}

const DEFAULT_WINDOW = 20;

/**
 * Convert a slice of AgentMeet message rows into OpenAI chat-completion turns.
 * The agent's own past messages become `assistant`, everyone else's become `user`.
 * Non-chat kinds and rows with no text are dropped.
 *
 * Other participants' text is untrusted: each message is rendered on one line
 * behind a label the kit adds, and message / transcript length is bounded
 * (see ../transcript.ts).
 */
export function buildTranscript(input: BuildPromptInput): TranscriptTurn[] {
  const window = input.windowSize ?? DEFAULT_WINDOW;
  const slice = input.history.slice(-window);
  const turns: TranscriptTurn[] = [];
  for (const row of slice) {
    if (row.kind !== 'chat') continue;
    const chat = readChatText(row.body);
    if (!chat) continue;
    const isSelf = input.selfAgentId !== null && row.senderAgentId === input.selfAgentId;
    const author = isSelf
      ? 'me'
      : speakerLabel(row.senderAgentId ?? row.senderUserId ?? 'unknown');
    turns.push({
      role: isSelf ? 'assistant' : 'user',
      content: isSelf
        ? clampText(chat.text, MAX_MESSAGE_CHARS)
        : renderSpeakerLine(author, chat.text),
      author,
    });
  }
  return fitTranscript(turns);
}

/**
 * Collapse consecutive same-role turns. OpenAI chat.completions accepts
 * non-alternating turns, but collapsing keeps payloads small and matches the
 * behaviour of the Anthropic sibling kit. We join same-role runs with newlines.
 */
export function collapseTurns(turns: readonly TranscriptTurn[]): TranscriptTurn[] {
  const out: TranscriptTurn[] = [];
  for (const turn of turns) {
    const last = out[out.length - 1];
    if (last && last.role === turn.role) {
      out[out.length - 1] = {
        role: last.role,
        author: last.author,
        content: `${last.content}\n${turn.content}`,
      };
    } else {
      out.push({ ...turn });
    }
  }
  // Trim leading assistant turns so the first message is always `user`.
  while (out.length > 0 && out[0]?.role !== 'user') out.shift();
  return out;
}

export interface FormatReplyInput {
  readonly raw: string;
  readonly maxLength?: number;
}

const DEFAULT_MAX_REPLY = 4000;

export function formatReply(input: FormatReplyInput): string {
  const max = input.maxLength ?? DEFAULT_MAX_REPLY;
  const trimmed = input.raw.trim();
  if (trimmed.length === 0) return '(no reply)';
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

/** Where the OpenAI SDK sends requests when no override is configured. */
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export interface OpenAIResponderOptions {
  readonly apiKey: string;
  readonly model: string;
  /** Validated OPENAI_BASE_URL from src/config.ts. Blank/omitted = OpenAI default. */
  readonly baseURL?: string;
  readonly persona: string;
  readonly maxTokens?: number;
}

export class OpenAIResponder {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly persona: string;
  private readonly maxTokens: number;

  constructor(opts: OpenAIResponderOptions) {
    // Always pass baseURL: left out, the SDK reads OPENAI_BASE_URL from the
    // environment on its own and would skip the check in src/config.ts.
    const baseURL =
      opts.baseURL !== undefined && opts.baseURL.length > 0 ? opts.baseURL : OPENAI_DEFAULT_BASE_URL;
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL });
    this.model = opts.model;
    this.persona = opts.persona;
    this.maxTokens = opts.maxTokens ?? 1024;
  }

  public async respond(turns: readonly TranscriptTurn[]): Promise<string> {
    const collapsed = collapseTurns(turns);
    if (collapsed.length === 0) {
      return '(no context to respond to)';
    }
    const res = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [
        { role: 'system', content: `${this.persona}\n\n${TRANSCRIPT_NOTE}` },
        ...collapsed.map((t) => ({ role: t.role, content: t.content })),
      ],
    });
    const text = res.choices[0]?.message?.content ?? '';
    return formatReply({ raw: text });
  }
}
