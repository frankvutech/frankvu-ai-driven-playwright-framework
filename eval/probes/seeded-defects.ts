import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';

/**
 * Independent verification of the seeded-defect catalog in
 * eval/dataset/functional.json. It drives the demo site with raw selectors
 * (not the framework's page objects or the agent's tests) and checks, for
 * every account, whether each catalogued defect is present. Exit code 1 if the
 * catalog and the observed behaviour disagree.
 */
const BASE = 'https://www.saucedemo.com';
const PASSWORD = process.env.SAUCE_PASSWORD ?? 'secret_sauce';
const ACCOUNTS = { standard: 'standard_user', problem: 'problem_user', error: 'error_user' } as const;
type Variant = keyof typeof ACCOUNTS;

async function signIn(page: Page, user: string) {
  page.on('dialog', (d) => void d.dismiss());
  await page.goto(BASE);
  await page.fill('[data-test="username"]', user);
  await page.fill('[data-test="password"]', PASSWORD);
  await page.click('[data-test="login-button"]');
  await page.waitForURL(/inventory\.html/);
}

const badge = (page: Page) => page.locator('[data-test="shopping-cart-badge"]').textContent({ timeout: 1000 }).catch(() => null);
const settle = (page: Page) => page.waitForTimeout(300); // let the demo app's synchronous React update render

/** Returns true when the defect is observed. */
const CHECKS: Record<string, (page: Page) => Promise<boolean>> = {
  'D-SORT': async (page) => {
    await page.selectOption('[data-test="product-sort-container"]', 'za');
    await settle(page);
    return (await page.locator('[data-test="inventory-item-name"]').first().textContent()) !== 'Test.allTheThings() T-Shirt (Red)';
  },
  'D-ADD': async (page) => {
    await page.click('[data-test="add-to-cart-sauce-labs-bolt-t-shirt"]');
    await settle(page);
    return (await badge(page)) !== '1';
  },
  'D-REMOVE': async (page) => {
    await page.click('[data-test="add-to-cart-sauce-labs-backpack"]');
    await settle(page);
    await page.click('[data-test="remove-sauce-labs-backpack"]');
    await settle(page);
    return (await badge(page)) !== null;
  },
  'D-LASTNAME': async (page) => {
    await page.goto(`${BASE}/checkout-step-one.html`);
    await page.fill('[data-test="firstName"]', 'Ada');
    await page.fill('[data-test="lastName"]', 'Lovelace');
    // The defect: the last name lands in the first-name field.
    return (await page.inputValue('[data-test="firstName"]')) === 'Lovelace';
  },
  'D-LASTNAME-VALIDATION': async (page) => {
    await page.goto(`${BASE}/checkout-step-one.html`);
    await page.fill('[data-test="firstName"]', 'Ada');
    await page.fill('[data-test="postalCode"]', '10115');
    await page.click('[data-test="continue"]');
    await settle(page);
    return page.url().includes('checkout-step-two');
  },
  'D-FINISH': async (page) => {
    await page.click('[data-test="add-to-cart-sauce-labs-backpack"]');
    await page.goto(`${BASE}/checkout-step-one.html`);
    await page.fill('[data-test="firstName"]', 'Ada');
    await page.fill('[data-test="lastName"]', 'Lovelace');
    await page.fill('[data-test="postalCode"]', '10115');
    await page.click('[data-test="continue"]');
    await page.waitForURL(/checkout-step-two/, { timeout: 5000 }).catch(() => undefined);
    if (!page.url().includes('checkout-step-two')) return false; // cannot reach finish: not this defect
    await page.click('[data-test="finish"]');
    await settle(page);
    return !page.url().includes('checkout-complete');
  },
};

async function main(): Promise<number> {
  const dataset = JSON.parse(readFileSync(path.join(__dirname, '../dataset/functional.json'), 'utf8')) as {
    defects: Array<{ id: string; variants: Variant[] }>;
  };
  const browser = await chromium.launch();
  const rows: Array<{ defect: string; variant: Variant; expected: boolean; observed: boolean[] }> = [];
  try {
    for (const defect of dataset.defects) {
      const check = CHECKS[defect.id];
      if (!check) throw new Error(`no probe for ${defect.id}`);
      for (const variant of Object.keys(ACCOUNTS) as Variant[]) {
        const observed: boolean[] = [];
        for (let rep = 0; rep < 2; rep++) {
          const context = await browser.newContext();
          const page = await context.newPage();
          try {
            await signIn(page, ACCOUNTS[variant]);
            observed.push(await check(page));
          } finally {
            await context.close();
          }
        }
        rows.push({ defect: defect.id, variant, expected: defect.variants.includes(variant), observed });
      }
    }
  } finally {
    await browser.close();
  }
  let mismatches = 0;
  for (const r of rows) {
    const ok = r.observed.every((o) => o === r.expected);
    if (!ok) mismatches += 1;
    process.stdout.write(`${ok ? 'ok      ' : 'MISMATCH'} ${r.defect.padEnd(22)} ${r.variant.padEnd(9)} expected=${r.expected} observed=${r.observed.join(',')}\n`);
  }
  process.stdout.write(`${rows.length} checks, ${mismatches} mismatch(es)\n`);
  return mismatches === 0 ? 0 : 1;
}

main().then((c) => process.exit(c), (e: unknown) => {
  process.stderr.write(String(e instanceof Error ? e.stack : e) + '\n');
  process.exit(1);
});
