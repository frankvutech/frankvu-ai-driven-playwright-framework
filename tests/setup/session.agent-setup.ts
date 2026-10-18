import { test as setup, expect } from '@playwright/test';
import { LoginPage } from '../../src/pages/LoginPage';
import { users } from '../../src/data/users';

/**
 * Session setup for the agent-only Playwright config. It signs in as the
 * session variant the execution adapter selected from the policy ("standard",
 * or a seeded-defect account), and stores the state inside the run directory.
 * The Phase 1 setup project does not match this file.
 */
const variant = process.env.RELYNX_SESSION_USER ?? 'standard';
const statePath = process.env.RELYNX_SESSION_STATE;
if (variant !== 'standard' && variant !== 'problem' && variant !== 'error') throw new Error(`unknown session variant ${variant}`);
if (!statePath) throw new Error('RELYNX_SESSION_STATE is not set');
const user = users[variant];

setup(`sign in as ${variant} session user`, async ({ page }) => {
  const loginPage = new LoginPage(page);
  await loginPage.goto();
  await loginPage.login(user.username, user.password);
  await expect(page).toHaveURL(/inventory\.html/);
  await page.context().storageState({ path: statePath });
});
