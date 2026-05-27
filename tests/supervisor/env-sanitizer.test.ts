import { describe, expect, it } from 'bun:test';
import { sanitizeEnv } from '../../src/supervisor/env-sanitizer.js';

describe('sanitizeEnv', () => {
  it('strips variables with CODEXCODE_ prefix', () => {
    const result = sanitizeEnv({
      CODEXCODE_FOO: 'bar',
      CODEXCODE_SOMETHING: 'value',
      PATH: '/usr/bin'
    });

    expect(result.CODEXCODE_FOO).toBeUndefined();
    expect(result.CODEXCODE_SOMETHING).toBeUndefined();
    expect(result.PATH).toBe('/usr/bin');
  });

  it('strips variables with CODEX_CODE_ prefix but preserves allowed ones', () => {
    const result = sanitizeEnv({
      CODEX_CODE_BAR: 'baz',
      CODEX_CODE_OAUTH_TOKEN: 'token',
      HOME: '/home/user'
    });

    expect(result.CODEX_CODE_BAR).toBeUndefined();
    expect(result.CODEX_CODE_OAUTH_TOKEN).toBe('token');
    expect(result.HOME).toBe('/home/user');
  });

  it('strips exact-match variables (CODEXCODE, CODEX_CODE_SESSION, CODEX_CODE_ENTRYPOINT, MCP_SESSION_ID)', () => {
    const result = sanitizeEnv({
      CODEXCODE: '1',
      CODEX_CODE_SESSION: 'session-123',
      CODEX_CODE_ENTRYPOINT: 'hook',
      MCP_SESSION_ID: 'mcp-abc',
      NODE_PATH: '/usr/local/lib'
    });

    expect(result.CODEXCODE).toBeUndefined();
    expect(result.CODEX_CODE_SESSION).toBeUndefined();
    expect(result.CODEX_CODE_ENTRYPOINT).toBeUndefined();
    expect(result.MCP_SESSION_ID).toBeUndefined();
    expect(result.NODE_PATH).toBe('/usr/local/lib');
  });

  it('preserves allowed variables like PATH, HOME, NODE_PATH', () => {
    const result = sanitizeEnv({
      PATH: '/usr/bin:/usr/local/bin',
      HOME: '/home/user',
      NODE_PATH: '/usr/local/lib/node_modules',
      SHELL: '/bin/zsh',
      USER: 'developer',
      LANG: 'en_US.UTF-8'
    });

    expect(result.PATH).toBe('/usr/bin:/usr/local/bin');
    expect(result.HOME).toBe('/home/user');
    expect(result.NODE_PATH).toBe('/usr/local/lib/node_modules');
    expect(result.SHELL).toBe('/bin/zsh');
    expect(result.USER).toBe('developer');
    expect(result.LANG).toBe('en_US.UTF-8');
  });

  it('returns a new object and does not mutate the original', () => {
    const original: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      CODEXCODE_FOO: 'bar',
      KEEP: 'yes'
    };
    const originalCopy = { ...original };

    const result = sanitizeEnv(original);

    expect(result).not.toBe(original);

    expect(original).toEqual(originalCopy);

    expect(result.CODEXCODE_FOO).toBeUndefined();
    expect(result.PATH).toBe('/usr/bin');
  });

  it('handles empty env gracefully', () => {
    const result = sanitizeEnv({});
    expect(result).toEqual({});
  });

  it('skips entries with undefined values', () => {
    const env: NodeJS.ProcessEnv = {
      DEFINED: 'value',
      UNDEFINED_KEY: undefined
    };

    const result = sanitizeEnv(env);
    expect(result.DEFINED).toBe('value');
    expect('UNDEFINED_KEY' in result).toBe(false);
  });

  it('combines prefix and exact match removal in a single pass', () => {
    const result = sanitizeEnv({
      PATH: '/usr/bin',
      CODEXCODE: '1',
      CODEXCODE_FOO: 'bar',
      CODEX_CODE_BAR: 'baz',
      CODEX_CODE_OAUTH_TOKEN: 'oauth-token',
      CODEX_CODE_SESSION: 'session',
      CODEX_CODE_ENTRYPOINT: 'entry',
      MCP_SESSION_ID: 'mcp',
      KEEP_ME: 'yes'
    });

    expect(result.PATH).toBe('/usr/bin');
    expect(result.KEEP_ME).toBe('yes');
    expect(result.CODEXCODE).toBeUndefined();
    expect(result.CODEXCODE_FOO).toBeUndefined();
    expect(result.CODEX_CODE_BAR).toBeUndefined();
    expect(result.CODEX_CODE_OAUTH_TOKEN).toBe('oauth-token');
    expect(result.CODEX_CODE_SESSION).toBeUndefined();
    expect(result.CODEX_CODE_ENTRYPOINT).toBeUndefined();
    expect(result.MCP_SESSION_ID).toBeUndefined();
  });

  it('preserves CODEX_CODE_GIT_BASH_PATH through sanitization', () => {
    const result = sanitizeEnv({
      CODEX_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe',
      PATH: '/usr/bin',
      HOME: '/home/user'
    });

    expect(result.CODEX_CODE_GIT_BASH_PATH).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(result.PATH).toBe('/usr/bin');
    expect(result.HOME).toBe('/home/user');
  });

  it('strips proxy env vars (uppercase and lowercase) so the worker subprocess is not routed through the user proxy', () => {
    const result = sanitizeEnv({
      HTTP_PROXY: 'http://bad-proxy:1234',
      HTTPS_PROXY: 'http://bad-proxy:1234',
      ALL_PROXY: 'socks5://bad-proxy:1080',
      NO_PROXY: 'localhost,127.0.0.1',
      http_proxy: 'http://bad-proxy:1234',
      https_proxy: 'http://bad-proxy:1234',
      all_proxy: 'socks5://bad-proxy:1080',
      no_proxy: 'localhost,127.0.0.1',
      npm_config_proxy: 'http://bad-proxy:1234',
      npm_config_https_proxy: 'http://bad-proxy:1234',
      PATH: '/usr/bin'
    });

    expect(result.HTTP_PROXY).toBeUndefined();
    expect(result.HTTPS_PROXY).toBeUndefined();
    expect(result.ALL_PROXY).toBeUndefined();
    expect(result.NO_PROXY).toBeUndefined();
    expect(result.http_proxy).toBeUndefined();
    expect(result.https_proxy).toBeUndefined();
    expect(result.all_proxy).toBeUndefined();
    expect(result.no_proxy).toBeUndefined();
    expect(result.npm_config_proxy).toBeUndefined();
    expect(result.npm_config_https_proxy).toBeUndefined();
    expect(result.PATH).toBe('/usr/bin');
  });

  it('selectively preserves only allowed CODEX_CODE_* vars while stripping others', () => {
    const result = sanitizeEnv({
      CODEX_CODE_OAUTH_TOKEN: 'my-oauth-token',
      CODEX_CODE_GIT_BASH_PATH: '/usr/bin/bash',
      CODEX_CODE_RANDOM_OTHER: 'should-be-stripped',
      CODEX_CODE_INTERNAL_FLAG: 'should-be-stripped',
      PATH: '/usr/bin'
    });

    expect(result.CODEX_CODE_OAUTH_TOKEN).toBe('my-oauth-token');
    expect(result.CODEX_CODE_GIT_BASH_PATH).toBe('/usr/bin/bash');

    expect(result.CODEX_CODE_RANDOM_OTHER).toBeUndefined();
    expect(result.CODEX_CODE_INTERNAL_FLAG).toBeUndefined();

    expect(result.PATH).toBe('/usr/bin');
  });
});
