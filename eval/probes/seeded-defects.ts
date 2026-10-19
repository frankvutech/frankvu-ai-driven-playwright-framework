import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { EXAMPLE_APP_VARIANTS, startExampleApp, type ExampleAppVariant } from '../../example-app/server';

/**
 * Independent verification of the seeded-defect catalog in
 * eval/dataset/functional.json. It drives the demo site with raw selectors
 * (not the framework's page objects or the agent's tests) and checks, for
 * every account, whether each catalogued defect is present. Example-app
 * defects (D-NOTES-*) are checked the same way with raw HTTP against a fresh
 * local app per variant. Exit code 1 if the catalog and the observed behaviour
 * disagree.
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

/* ------------------------- example app (raw HTTP) ------------------------- */

const NOTES_PASSWORD = 'probe-password-1';
async function token(base: string, username: string): Promise<string> {
  const r = await fetch(`${base}/api/auth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: NOTES_PASSWORD }) });
  return ((await r.json()) as { token: string }).token;
}
const createNote = (base: string, t: string, title: string) =>
  fetch(`${base}/api/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: JSON.stringify({ title }) });

const NOTES_CHECKS: Record<string, (base: string) => Promise<boolean>> = {
  'D-NOTES-CREATE': async (base) => (await createNote(base, await token(base, 'alice'), 'probe')).status !== 201,
  'D-NOTES-AUTHZ': async (base) => {
    const alice = await token(base, 'alice');
    const bob = await token(base, 'bob');
    const created = await createNote(base, alice, 'private');
    if (created.status !== 201) return false; // cannot set up: not this defect
    const { id } = (await created.json()) as { id: string };
    return (await fetch(`${base}/api/notes/${id}`, { headers: { Authorization: `Bearer ${bob}` } })).status === 200;
  },
  'D-NOTES-TITLELEN': async (base) => (await createNote(base, await token(base, 'alice'), 'x'.repeat(121))).status === 201,
};

async function probeExampleApp(defects: Array<{ id: string; variants: string[] }>) {
  const rows: Array<{ defect: string; variant: string; expected: boolean; observed: boolean[] }> = [];
  for (const defect of defects) {
    const check = NOTES_CHECKS[defect.id];
    if (!check) throw new Error(`no probe for ${defect.id}`);
    for (const variant of EXAMPLE_APP_VARIANTS as readonly ExampleAppVariant[]) {
      const observed: boolean[] = [];
      for (let rep = 0; rep < 2; rep++) {
        const app = await startExampleApp({ users: [{ username: 'alice', password: NOTES_PASSWORD }, { username: 'bob', password: NOTES_PASSWORD }], variant });
        try {
          observed.push(await check(app.url));
        } finally {
          await app.close();
        }
      }
      rows.push({ defect: defect.id, variant, expected: defect.variants.includes(variant), observed });
    }
  }
  return rows;
}

async function main(): Promise<number> {
  const dataset = JSON.parse(readFileSync(path.join(__dirname, '../dataset/functional.json'), 'utf8')) as {
    defects: Array<{ id: string; variants: string[] }>;
  };
  const storefront = dataset.defects.filter((d) => !d.id.startsWith('D-NOTES-'));
  const rows: Array<{ defect: string; variant: string; expected: boolean; observed: boolean[] }> = await probeExampleApp(dataset.defects.filter((d) => d.id.startsWith('D-NOTES-')));
  const browser = await chromium.launch();
  try {
    for (const defect of storefront) {
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
