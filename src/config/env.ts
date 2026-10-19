import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv as parseDotEnv } from 'node:util';
import { z } from 'zod';
import { EXAMPLE_APP_VARIANTS } from '../../example-app/server';

/**
 * Single place where environment-specific values are resolved and validated.
 * Page objects and API clients never read process.env; they navigate with
 * relative paths and get base URLs from playwright.config.ts or fixtures.
 *
 * Precedence: real environment variables, then an optional `.env` file at the
 * repository root, then the defaults below. Only the keys in this schema are
 * read from `.env`, and it is never copied into process.env, so unrelated
 * secrets kept there do not reach child processes.
 */
const BROWSERS = ['chromium', 'firefox', 'webkit'] as const;
export type BrowserName = (typeof BROWSERS)[number];

const httpUrl = z
  .url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
  .transform((u) => u.replace(/\/+$/, ''));

const EnvSchema = z.object({
  UI_BASE_URL: httpUrl.default('https://www.saucedemo.com'),
  API_BASE_URL: httpUrl.default('https://jsonplaceholder.typicode.com'),
  /** Unset: tests start the local example app themselves (see example-app/). */
  EXAMPLE_APP_URL: httpUrl.optional(),
  /** Only used when the tests start the example app themselves. */
  EXAMPLE_APP_VARIANT: z.enum(EXAMPLE_APP_VARIANTS, { error: `must be one of: ${EXAMPLE_APP_VARIANTS.join(', ')}` }).default('standard'),
  UI_BROWSERS: z
    .string()
    .default('chromium')
    .transform((v) => v.split(',').map((b) => b.trim()).filter(Boolean))
    .pipe(z.array(z.enum(BROWSERS, { error: `must list browsers from: ${BROWSERS.join(', ')}` })).min(1, 'must list at least one browser')),
  SAUCE_PASSWORD: z.string().min(1).default('secret_sauce'),
  EXAMPLE_APP_PASSWORD: z.string().min(8, 'must be at least 8 characters').default('example-app-pass'),
});

export type EnvKey = keyof typeof EnvSchema.shape;
export const ENV_KEYS = Object.keys(EnvSchema.shape) as EnvKey[];

/**
 * Validates a set of raw values. Error messages name the variable and the
 * rule it broke, never the value, so a mistyped secret is not echoed to logs.
 */
export function parseEnv(source: Partial<Record<string, string | undefined>>) {
  const picked = Object.fromEntries(ENV_KEYS.map((k) => [k, source[k] === '' ? undefined : source[k]]));
  const result = EnvSchema.safeParse(picked);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid test environment configuration:\n${problems.join('\n')}`);
  }
  const v = result.data;
  return {
    uiBaseUrl: v.UI_BASE_URL,
    apiBaseUrl: v.API_BASE_URL,
    exampleAppUrl: v.EXAMPLE_APP_URL,
    exampleAppVariant: v.EXAMPLE_APP_VARIANT,
    uiBrowsers: [...new Set(v.UI_BROWSERS)],
    saucePassword: v.SAUCE_PASSWORD,
    exampleAppPassword: v.EXAMPLE_APP_PASSWORD,
  } as const;
}

export type Env = ReturnType<typeof parseEnv>;

/** Reads the optional `.env` file. Returns only the keys this framework knows. */
export function readDotEnv(file: string): Partial<Record<EnvKey, string>> {
  if (!existsSync(file)) return {};
  const all = parseDotEnv(readFileSync(file, 'utf8'));
  return Object.fromEntries(ENV_KEYS.filter((k) => all[k] !== undefined).map((k) => [k, all[k]]));
}

const DOT_ENV_FILE = path.resolve(__dirname, '../../.env');

export const env: Env = parseEnv({ ...readDotEnv(DOT_ENV_FILE), ...pickDefined(process.env) });

function pickDefined(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(source).filter((e): e is [string, string] => e[1] !== undefined));
}
