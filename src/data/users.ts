import { env } from '../config/env';

/**
 * Demo accounts for saucedemo.com. The site publishes these on its login
 * page; they are not secrets. Override the password via SAUCE_PASSWORD when
 * pointing the suite at a different environment.
 */
const password = env.saucePassword;

export const users = {
  standard: { username: 'standard_user', password },
  lockedOut: { username: 'locked_out_user', password },
  // Intentionally defective accounts on the demo site. Used only as seeded-
  // defect variants by the Phase 3 evaluation (see relynx.policy.json).
  problem: { username: 'problem_user', password },
  error: { username: 'error_user', password },
} as const;

export type User = (typeof users)[keyof typeof users];
