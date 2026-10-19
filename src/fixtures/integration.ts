import { test as apiTest } from './api';
import { exampleAppUsers, type ExampleAppUserName } from '../data/exampleApp';
import { NotesLoginPage } from '../pages/example-app/NotesLoginPage';
import { NotesPage } from '../pages/example-app/NotesPage';

type IntegrationFixtures = {
  notesLoginPage: NotesLoginPage;
  notesPage: NotesPage;
  /** Signs the browser in through the app's login endpoint (no UI steps). */
  signInBrowser: (user: ExampleAppUserName) => Promise<void>;
};

/**
 * UI + API workflows against the example app: the API fixtures plus page
 * objects, with the browser pointed at the same app instance as the API.
 */
export const test = apiTest.extend<IntegrationFixtures>({
  baseURL: async ({ exampleAppUrl }, use) => use(exampleAppUrl),
  notesLoginPage: async ({ page }, use) => use(new NotesLoginPage(page)),
  notesPage: async ({ page }, use) => use(new NotesPage(page)),

  signInBrowser: async ({ page, exampleAppApi }, use) => {
    await use(async (user) => {
      // Registers the user for test-data cleanup as well.
      await exampleAppApi.as(user);
      // page.request shares the browser context's cookie jar.
      const response = await page.request.post('/login', { form: exampleAppUsers[user], maxRedirects: 0 });
      if (response.status() !== 303) throw new Error(`Browser sign-in as "${user}" failed: HTTP ${response.status()}`);
    });
  },
});

export { expect } from '@playwright/test';
