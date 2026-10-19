import { writeFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { parseEnv, readDotEnv } from '../../src/config/env';

test.describe('environment configuration', () => {
  test('uses documented defaults when nothing is set', () => {
    expect(parseEnv({})).toEqual({
      uiBaseUrl: 'https://www.saucedemo.com',
      apiBaseUrl: 'https://jsonplaceholder.typicode.com',
      exampleAppUrl: undefined,
      uiBrowsers: ['chromium'],
      saucePassword: 'secret_sauce',
      exampleAppPassword: 'example-app-pass',
    });
  });

  test('treats empty values as unset and strips trailing slashes', () => {
    const env = parseEnv({ UI_BASE_URL: 'https://staging.example.test/', API_BASE_URL: '' });

    expect(env.uiBaseUrl).toBe('https://staging.example.test');
    expect(env.apiBaseUrl).toBe('https://jsonplaceholder.typicode.com');
  });

  test('parses and de-duplicates the browser list', () => {
    expect(parseEnv({ UI_BROWSERS: 'chromium, webkit,chromium' }).uiBrowsers).toEqual(['chromium', 'webkit']);
  });

  test('rejects an unknown browser', () => {
    expect(() => parseEnv({ UI_BROWSERS: 'chromium,edge' })).toThrow(/UI_BROWSERS\.1: must list browsers from: chromium, firefox, webkit/);
  });

  test('rejects non-http URLs, naming the variable', () => {
    expect(() => parseEnv({ API_BASE_URL: 'ftp://files.example.test' })).toThrow(/API_BASE_URL: must be an http\(s\) URL/);
    expect(() => parseEnv({ EXAMPLE_APP_URL: 'not a url' })).toThrow(/EXAMPLE_APP_URL/);
  });

  test('never echoes a rejected secret value', () => {
    const secret = 'short';

    const message = (() => {
      try {
        parseEnv({ EXAMPLE_APP_PASSWORD: secret });
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    })();

    expect(message).toContain('EXAMPLE_APP_PASSWORD: must be at least 8 characters');
    expect(message).not.toContain(secret);
  });

  test('reads only known keys from a .env file', () => {
    const file = test.info().outputPath('.env');
    writeFileSync(file, 'UI_BASE_URL=https://from-file.example.test\nANTHROPIC_API_KEY=sk-should-not-be-read\n# comment\n');

    expect(readDotEnv(file)).toEqual({ UI_BASE_URL: 'https://from-file.example.test' });
    expect(readDotEnv(test.info().outputPath('missing.env'))).toEqual({});
  });
});
