import { env } from '../config/env';

/**
 * Users of the local example app (example-app/). The local app is started
 * with exactly these accounts, so they are test fixtures, not real accounts.
 * Two owners are needed to exercise 403 (another user's note).
 */
export const exampleAppUsers = {
  alice: { username: 'alice', password: env.exampleAppPassword },
  bob: { username: 'bob', password: env.exampleAppPassword },
} as const;

export type ExampleAppUserName = keyof typeof exampleAppUsers;
