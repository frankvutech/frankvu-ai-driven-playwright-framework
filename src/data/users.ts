/**
 * Demo accounts for saucedemo.com. The site publishes these on its login
 * page; they are not secrets. Override the password via SAUCE_PASSWORD when
 * pointing the suite at a different environment.
 */
const password = process.env.SAUCE_PASSWORD ?? 'secret_sauce';

export const users = {
  standard: { username: 'standard_user', password },
  lockedOut: { username: 'locked_out_user', password },
} as const;

export type User = (typeof users)[keyof typeof users];
