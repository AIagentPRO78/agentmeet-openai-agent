import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isLoopbackHost, serviceUrlProblem } from '../src/url-safety.js';
import { parseEnv } from '../src/config.js';
import { OPENAI_DEFAULT_BASE_URL, OpenAIResponder } from '../src/openai/responder.js';

describe('serviceUrlProblem', () => {
  it.each([
    'https://api.openai.com/v1',
    'https://your-gateway.example.com/v1',
    'https://gateway.example.com:8443/openai/v1/',
    'https://localhost/v1',
    'http://localhost:11434/v1',
    'http://LOCALHOST:11434/v1',
    'http://127.0.0.1:11434/v1',
    'http://127.0.0.1/v1',
    'http://[::1]:11434/v1',
  ])('accepts %s', (url) => {
    expect(serviceUrlProblem(url)).toBeNull();
  });

  it.each([
    // plain http to anything that is not this machine
    'http://api.openai.com/v1',
    'http://llm-gw.internal/v1',
    'http://192.168.1.20:11434/v1',
    'http://10.0.0.5/v1',
    'http://0.0.0.0:11434/v1',
    'http://host.docker.internal:11434/v1',
    // hosts that only look like loopback
    'http://localhost.evil.test/v1',
    'http://127.0.0.1.evil.test/v1',
    'http://localhost.:11434/v1',
    'http://127.0.0.2/v1',
    'http://[::ffff:127.0.0.1]/v1',
    // other schemes
    'ftp://example.com/v1',
    'ws://localhost:11434/v1',
    'file:///etc/passwd',
    'javascript:alert(1)',
  ])('rejects %s (not https, not loopback)', (url) => {
    expect(serviceUrlProblem(url)).toMatch(/must use https/);
  });

  it.each([
    'https://user:pass@gateway.example.com/v1',
    'https://user@gateway.example.com/v1',
    'https://:pass@gateway.example.com/v1',
    'http://user:pass@localhost:11434/v1',
    // "localhost" here is a username; the real host is evil.test
    'http://localhost@evil.test/v1',
    'https://api.openai.com@evil.test/v1',
  ])('rejects embedded credentials in %s', (url) => {
    expect(serviceUrlProblem(url)).toMatch(/must not contain credentials/);
  });

  it.each(['', 'not a url', 'api.openai.com/v1', '//api.openai.com/v1', 'https://'])(
    'rejects %j (not an absolute URL)',
    (url) => {
      expect(serviceUrlProblem(url)).toMatch(/not a valid absolute URL/);
    },
  );

  it('never repeats the URL (or a secret inside it) in the reason', () => {
    for (const url of [
      'https://user:s3cr3t-value@gateway.example.com/v1',
      'http://gateway.example.com/v1?key=s3cr3t-value',
      's3cr3t-value',
    ]) {
      const problem = serviceUrlProblem(url) ?? '';
      expect(problem.length).toBeGreaterThan(0);
      expect(problem).not.toContain('s3cr3t-value');
      expect(problem).not.toContain('gateway.example.com');
    }
  });

  it('the built-in default passes', () => {
    expect(serviceUrlProblem(OPENAI_DEFAULT_BASE_URL)).toBeNull();
  });
});

describe('isLoopbackHost', () => {
  it('matches exactly localhost, 127.0.0.1 and [::1]', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('localhost.example.com')).toBe(false);
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost('')).toBe(false);
  });
});

describe('OPENAI_BASE_URL validation at startup', () => {
  const base = { OPENAI_API_KEY: 'test-key', AGENTMEET_BEARER_TOKEN: 'test-token' };

  it('is optional: unset or blank falls back to the OpenAI default', () => {
    expect(parseEnv(base).OPENAI_BASE_URL).toBe('');
    expect(parseEnv({ ...base, OPENAI_BASE_URL: '' }).OPENAI_BASE_URL).toBe('');
    expect(parseEnv({ ...base, OPENAI_BASE_URL: '   ' }).OPENAI_BASE_URL).toBe('');
  });

  it.each([
    'https://your-gateway.example.com/v1',
    'http://localhost:11434/v1',
    'http://127.0.0.1:8080/v1',
    'http://[::1]:8080/v1',
  ])('accepts %s', (url) => {
    expect(parseEnv({ ...base, OPENAI_BASE_URL: url }).OPENAI_BASE_URL).toBe(url);
  });

  it('trims surrounding whitespace, as the OpenAI SDK did when it read the variable itself', () => {
    expect(
      parseEnv({ ...base, OPENAI_BASE_URL: '  https://your-gateway.example.com/v1 ' }).OPENAI_BASE_URL,
    ).toBe('https://your-gateway.example.com/v1');
  });

  it.each([
    ['http://llm-gw.internal/v1', 'OPENAI_BASE_URL must use https://'],
    ['http://192.168.1.20:11434/v1', 'OPENAI_BASE_URL must use https://'],
    ['http://localhost@evil.test/v1', 'OPENAI_BASE_URL must not contain credentials'],
    ['https://user:pass@gateway.example.com/v1', 'OPENAI_BASE_URL must not contain credentials'],
    ['gateway.example.com/v1', 'OPENAI_BASE_URL is not a valid absolute URL'],
  ])('refuses to start with OPENAI_BASE_URL=%s', (url, message) => {
    expect(() => parseEnv({ ...base, OPENAI_BASE_URL: url })).toThrow(message);
  });

  it('does not put the rejected URL into the error', () => {
    let message = '';
    try {
      parseEnv({ ...base, OPENAI_BASE_URL: 'https://user:s3cr3t-value@gateway.example.com/v1' });
    } catch (err: unknown) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('OPENAI_BASE_URL must not contain credentials');
    expect(message).not.toContain('s3cr3t-value');
  });
});

describe('OpenAIResponder base URL', () => {
  // The OpenAI SDK reads OPENAI_BASE_URL from the environment when no baseURL
  // is passed to it. The responder must only ever use the value it was given
  // (the one src/config.ts validated). fetch is stubbed: nothing leaves the process.
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.OPENAI_BASE_URL;
  let capturedUrl: string | null = null;

  beforeEach(() => {
    capturedUrl = null;
    globalThis.fetch = vi.fn(async (input: unknown) => {
      capturedUrl = typeof input === 'string' ? input : (input as { url: string }).url;
      return new Response(
        JSON.stringify({
          id: 'cmpl_test',
          object: 'chat.completion',
          created: 0,
          model: 'test',
          choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = originalEnv;
  });

  const opts = { apiKey: 'test-key', model: 'test-model', persona: 'You are a test bot.' };
  const ping = [{ role: 'user', author: 'a', content: 'ping' }] as const;

  it('uses the OpenAI default when no baseURL is given', async () => {
    delete process.env.OPENAI_BASE_URL;
    expect(await new OpenAIResponder(opts).respond(ping)).toBe('pong');
    expect(capturedUrl).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('a blank baseURL also means the OpenAI default', async () => {
    delete process.env.OPENAI_BASE_URL;
    expect(await new OpenAIResponder({ ...opts, baseURL: '' }).respond(ping)).toBe('pong');
    expect(capturedUrl).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('uses the baseURL it is given', async () => {
    delete process.env.OPENAI_BASE_URL;
    const responder = new OpenAIResponder({ ...opts, baseURL: 'http://127.0.0.1:9/v1' });
    expect(await responder.respond(ping)).toBe('pong');
    expect(capturedUrl).toBe('http://127.0.0.1:9/v1/chat/completions');
  });

  it('does not pick up an OPENAI_BASE_URL that did not go through config', async () => {
    process.env.OPENAI_BASE_URL = 'http://llm-gw.internal/v1';
    expect(await new OpenAIResponder(opts).respond(ping)).toBe('pong');
    expect(capturedUrl).toBe('https://api.openai.com/v1/chat/completions');
  });
});
