import { users } from '../../data/users';

const PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED_API_KEY]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]'],
  [/\b(authorization|api[_-]?key|x-api-key|token|password|secret)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$2[REDACTED]'],
];

/** Secret values known to this process. Values shorter than 4 chars are ignored to avoid mangling text. */
export function knownSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const fromEnv = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'SAUCE_PASSWORD'].map((k) => env[k]);
  const fromData = Object.values(users).map((u) => u.password);
  return [...new Set([...fromEnv, ...fromData].filter((v): v is string => typeof v === 'string' && v.length >= 4))];
}

export function redact(text: string, secrets: string[] = knownSecrets()): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('[REDACTED]');
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
export const stripAnsi = (s: string) => s.replace(ANSI, '');
