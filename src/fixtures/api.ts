import { test as base, type APIRequestContext } from '@playwright/test';
import { env } from '../config/env';
import { exampleAppUsers, type ExampleAppUserName } from '../data/exampleApp';
import { NotesClient, requestToken } from '../api/NotesClient';
import { PostsClient } from '../api/PostsClient';
import { parseJson } from '../api/response';
import { NoteSchema, TokenSchema } from '../api/schemas';
import { startExampleApp } from '../../example-app/server';

export interface ExampleAppApi {
  /** Base URL of the example app under test. */
  url: string;
  /** A NotesClient signed in as this user (one token per user per test). */
  as(user: ExampleAppUserName): Promise<NotesClient>;
  /** A request context with no credentials, for 401 scenarios. */
  anonymous(): Promise<APIRequestContext>;
  /** A NotesClient with no credentials, for 401 scenarios through the client. */
  asAnonymous(): Promise<NotesClient>;
}

type ApiFixtures = {
  /** Unique per test (and per --repeat-each run). Prefix every title you create with it. */
  testPrefix: string;
  postsApi: PostsClient;
  exampleAppApi: ExampleAppApi;
};

type WorkerFixtures = {
  /** EXAMPLE_APP_URL if set, otherwise a local example app started once per worker. */
  exampleAppUrl: string;
};

/**
 * API fixtures. Every request context created here is disposed after the
 * test, and notes the test created (titles starting with `testPrefix`) are
 * deleted before and after it, so tests are repeatable and order-independent.
 */
export const test = base.extend<ApiFixtures, WorkerFixtures>({
  exampleAppUrl: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      if (env.exampleAppUrl) return use(env.exampleAppUrl);
      const app = await startExampleApp({ users: Object.values(exampleAppUsers), variant: env.exampleAppVariant });
      await use(app.url);
      await app.close();
    },
    { scope: 'worker' },
  ],

  // eslint-disable-next-line no-empty-pattern
  testPrefix: async ({}, use, testInfo) => {
    await use(`t-${testInfo.testId}-${testInfo.repeatEachIndex}`);
  },

  postsApi: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({
      baseURL: env.apiBaseUrl,
      extraHTTPHeaders: { Accept: 'application/json' },
    });
    await use(new PostsClient(context));
    await context.dispose();
  },

  exampleAppApi: async ({ playwright, exampleAppUrl, testPrefix }, use) => {
    const contexts: APIRequestContext[] = [];
    const clients = new Map<ExampleAppUserName, NotesClient>();

    const newContext = async (headers: Record<string, string> = {}) => {
      const context = await playwright.request.newContext({
        baseURL: exampleAppUrl,
        extraHTTPHeaders: { Accept: 'application/json', ...headers },
      });
      contexts.push(context);
      return context;
    };

    const as = async (user: ExampleAppUserName) => {
      const existing = clients.get(user);
      if (existing) return existing;
      const response = await requestToken(await newContext(), exampleAppUsers[user]);
      if (!response.ok()) throw new Error(`Could not get a token for example-app user "${user}": HTTP ${response.status()}`);
      const { token } = await parseJson(response, TokenSchema);
      const client = new NotesClient(await newContext({ Authorization: `Bearer ${token}` }));
      // Leftovers from an interrupted earlier run of this same test.
      await deleteNotesWithPrefix(client, testPrefix);
      clients.set(user, client);
      return client;
    };

    try {
      await use({ url: exampleAppUrl, as, anonymous: () => newContext(), asAnonymous: async () => new NotesClient(await newContext()) });
      for (const client of clients.values()) await deleteNotesWithPrefix(client, testPrefix);
    } finally {
      await Promise.all(contexts.map((c) => c.dispose()));
    }
  },
});

async function deleteNotesWithPrefix(client: NotesClient, prefix: string): Promise<void> {
  const notes = await parseJson(await client.list(), NoteSchema.array());
  for (const note of notes.filter((n) => n.title.startsWith(prefix))) {
    const response = await client.delete(note.id);
    if (response.status() !== 204 && response.status() !== 404) {
      throw new Error(`Cleanup could not delete note ${note.id}: HTTP ${response.status()}`);
    }
  }
}

export { expect } from '@playwright/test';
