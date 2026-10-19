import type { APIResponse } from '@playwright/test';
import type { z } from 'zod';

/**
 * Parses a JSON response body against a schema and returns it typed.
 * On failure the error names the request and the schema problems, but not
 * the body or headers, which may hold tokens or personal data.
 */
export async function parseJson<S extends z.ZodType>(response: APIResponse, schema: S): Promise<z.infer<S>> {
  const where = `${new URL(response.url()).pathname} (HTTP ${response.status()})`;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Response from ${where} is not JSON (content-type: ${response.headers()['content-type'] ?? 'none'})`);
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Response from ${where} does not match the expected schema:\n${problems}`);
  }
  return result.data;
}
