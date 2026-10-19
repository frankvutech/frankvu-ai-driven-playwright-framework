import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { CATALOG, NOTES_UI_CATALOG } from '../../src/agent/generation/catalog';
import { API_CATALOG, SCHEMA_EXPORTS, SCHEMA_FIELDS } from '../../src/agent/generation/apiCatalog';
import { NotesClient, requestToken } from '../../src/api/NotesClient';
import { PostsClient } from '../../src/api/PostsClient';
import * as schemas from '../../src/api/schemas';
import { NotesLoginPage } from '../../src/pages/example-app/NotesLoginPage';
import { NotesPage } from '../../src/pages/example-app/NotesPage';
import { LoginPage } from '../../src/pages/LoginPage';
import { InventoryPage } from '../../src/pages/InventoryPage';
import { CartPage } from '../../src/pages/CartPage';
import { CheckoutInformationPage } from '../../src/pages/CheckoutInformationPage';
import { CheckoutOverviewPage } from '../../src/pages/CheckoutOverviewPage';
import { CheckoutCompletePage } from '../../src/pages/CheckoutCompletePage';
import { REPO_ROOT } from './helpers';

const CLASSES: Record<string, new (page: import('@playwright/test').Page) => object> = {
  LoginPage, InventoryPage, CartPage, CheckoutInformationPage, CheckoutOverviewPage, CheckoutCompletePage,
};

const resolve = (obj: object, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((acc, key) => (acc as Record<string, unknown> | undefined)?.[key], obj);

test('every catalog entry exists on the real page objects and fixtures', async ({ page }) => {
  const fixtures = readFileSync(path.join(REPO_ROOT, 'src/fixtures/test.ts'), 'utf8');
  for (const [fixture, spec] of Object.entries(CATALOG)) {
    expect(fixtures, `fixture ${fixture}`).toContain(`${fixture}: async ({ page }, use) => use(new ${spec.className}(page))`);
    const instance = new CLASSES[spec.className](page);
    for (const method of Object.keys(spec.methods)) {
      expect(typeof resolve(instance, method), `${spec.className}.${method}`).toBe('function');
    }
    for (const locator of Object.keys(spec.locators)) {
      // Locator is not exported as a runtime class, so check its shape.
      const value = resolve(instance, locator) as Record<string, unknown> | undefined;
      expect(['click', 'first', 'last', 'filter', 'textContent'].every((m) => typeof value?.[m] === 'function'), `${spec.className}.${locator} is a Locator`).toBe(true);
    }
  }
});

const NOTES_CLASSES: Record<string, new (p: import('@playwright/test').Page) => object> = { NotesLoginPage, NotesPage };
const CLIENT_PROTOTYPES: Record<string, Record<string, unknown>> = {
  notes: NotesClient.prototype as unknown as Record<string, unknown>,
  posts: PostsClient.prototype as unknown as Record<string, unknown>,
  auth: { token: requestToken },
};

/** Every (client, method, return schema) in the API catalog. */
const apiMethods = () =>
  Object.entries(API_CATALOG).flatMap(([client, spec]) => Object.entries(spec.methods).map(([method, m]) => ({ client, method, returns: m.returns })));

/** Top-level schema keys each assertable field relies on ("*.id" -> id, "error.code" -> error, "length" is the list itself). */
const schemaFieldHeads = () =>
  (Object.entries(SCHEMA_FIELDS) as Array<[keyof typeof SCHEMA_EXPORTS, Record<string, string>]>).flatMap(([name, fields]) =>
    Object.keys(fields)
      .filter((f) => f !== 'length')
      .map((field) => ({ name, field, head: field.replace(/^\*\./, '').split('.')[0] })),
  );

test('every notes-app catalog entry exists on the real page objects and integration fixtures', async ({ page }) => {
  const fixtures = readFileSync(path.join(REPO_ROOT, 'src/fixtures/integration.ts'), 'utf8');
  for (const [fixture, spec] of Object.entries(NOTES_UI_CATALOG)) {
    expect(fixtures, `fixture ${fixture}`).toContain(`${fixture}: async ({ page }, use) => use(new ${spec.className}(page))`);
    expect(readFileSync(path.join(REPO_ROOT, spec.source), 'utf8')).toContain(`export class ${spec.className}`);
    const instance = new NOTES_CLASSES[spec.className](page);
    for (const method of [...Object.keys(spec.methods), ...Object.keys(spec.locatorMethods ?? {})]) {
      expect(typeof resolve(instance, method), `${spec.className}.${method}`).toBe('function');
    }
    for (const locator of Object.keys(spec.locators)) {
      const value = resolve(instance, locator) as Record<string, unknown> | undefined;
      expect(['click', 'first', 'filter'].every((m) => typeof value?.[m] === 'function'), `${spec.className}.${locator} is a Locator`).toBe(true);
    }
  }
  for (const spec of Object.values(CATALOG)) {
    expect(readFileSync(path.join(REPO_ROOT, spec.source), 'utf8')).toContain(`export class ${spec.className}`);
  }
});

test('every API catalog method, schema and field exists in src/api', () => {
  for (const { client, method, returns } of apiMethods()) {
    expect(typeof CLIENT_PROTOTYPES[client][method], `${client}.${method}`).toBe('function');
    expect(returns === null || SCHEMA_EXPORTS[returns] !== undefined, `${client}.${method} returns a known schema`).toBe(true);
  }
  const exported = schemas as unknown as Record<string, z.ZodObject>;
  for (const { name, field, head } of schemaFieldHeads()) {
    expect(Object.keys(exported[SCHEMA_EXPORTS[name].symbol].shape), `${name}.${field}`).toContain(head);
  }
});
