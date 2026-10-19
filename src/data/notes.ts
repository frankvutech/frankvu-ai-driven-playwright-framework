import type { NoteInput } from '../api/schemas';

/**
 * Builds note payloads whose titles start with a per-test prefix, so a test
 * only ever sees (and cleans up) its own data, even when workers share an app.
 */
export function buildNote(prefix: string, overrides: Partial<NoteInput> = {}): NoteInput {
  return {
    title: `${prefix} Groceries`,
    body: 'Milk, eggs, bread',
    ...overrides,
  };
}
