import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CATALOG } from '../../src/agent/generation/catalog';
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
