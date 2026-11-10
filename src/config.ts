import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { parseSenderList } from './reply-limiter.js';
import { serviceUrlProblem } from './url-safety.js';

// Integer from the environment. A blank value ("VAR=") means "use the default".
const intEnv = (def: number, min: number, max: number) =>
  z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().min(min).max(max).default(def),
  );

const EnvSchema = z
  .object({
    OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
    OPENAI_MODEL: z.string().default('gpt-4o'),
    // Optional override, the same variable the OpenAI SDK reads on its own.
    // The API key and every room transcript are sent here, so an override must
    // be https (plain http only to this machine, e.g. a local proxy).
    OPENAI_BASE_URL: z
      .string()
      .trim()
      .default('')
      .superRefine((u, ctx) => {
        if (u.length === 0) return;
        const problem = serviceUrlProblem(u);
        if (problem !== null) {
          ctx.addIssue({ code: 'custom', message: `OPENAI_BASE_URL ${problem}` });
        }
      }),
    AGENTMEET_BEARER_TOKEN: z.string().default(''),
    AGENTMEET_PROVISIONING_TOKEN: z.string().default(''),
    AGENTMEET_API_BASE: z
      .string()
      .url()
      .refine(
        (u) => {
          const url = new URL(u);
          if (url.protocol === 'https:') return true;
          // Allow plain http only on loopback for local dev convenience.
          return (
            url.protocol === 'http:' &&
            (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1')
          );
        },
        'AGENTMEET_API_BASE must be https:// (or http://localhost for dev only)',
      )
      .default('https://agentmeet.chat'),
    AGENTMEET_ROOM_ID: z.string().default(''),
    AGENT_NICK: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9_]+$/, 'AGENT_NICK must match /^[a-z0-9_]+$/')
      .default('gpt'),
    AGENT_NAME: z.string().min(1).max(128).default('GPT'),
    PERSONA_FILE: z.string().default('./personas/skeptic.txt'),
    // Reply limits (see src/reply-limiter.ts). Defaults are meant to stay out of
    // the way of a normal conversation while bounding loops and spend.
    REPLY_MAX_PER_WINDOW: intEnv(20, 1, 10_000),
    REPLY_WINDOW_SECONDS: intEnv(600, 1, 86_400),
    REPLY_MAX_AGENT_STREAK: intEnv(3, 0, 10_000),
    REPLY_ALLOWED_SENDERS: z.string().default('').transform(parseSenderList),
    LOG_LEVEL: z.string().default('info'),
  })
  .refine((v) => v.AGENTMEET_BEARER_TOKEN.length > 0 || v.AGENTMEET_PROVISIONING_TOKEN.length > 0, {
    message: 'either AGENTMEET_BEARER_TOKEN or AGENTMEET_PROVISIONING_TOKEN must be set',
  });

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig {
  readonly env: Env;
  readonly persona: string;
}

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  return EnvSchema.parse(source);
}

export async function loadPersona(personaFile: string): Promise<string> {
  const absolute = resolve(process.cwd(), personaFile);
  const raw = await readFile(absolute, 'utf-8');
  return raw.trim();
}

export async function loadConfig(source: NodeJS.ProcessEnv): Promise<AppConfig> {
  const env = parseEnv(source);
  const persona = await loadPersona(env.PERSONA_FILE);
  return { env, persona };
}
