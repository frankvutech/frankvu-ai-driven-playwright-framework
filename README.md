# AI-Driven Playwright Framework — Phase 1

Playwright Test + TypeScript framework built on the **Page Object Model**.

| Layer | Target | Default URL (override with env var) |
|-------|--------|--------------------------------------|
| UI    | Sauce Demo storefront | `https://www.saucedemo.com` (`UI_BASE_URL`) |
| API   | JSONPlaceholder REST  | `https://jsonplaceholder.typicode.com` (`API_BASE_URL`) |

Both targets are public demo sites. The tests depend on them being up.

## Quick start

```bash
npm ci
npx playwright install chromium
npm test              # setup + UI + API
npm run test:ui       # UI only (runs the auth setup first)
npm run test:api      # API only
npm run typecheck
npm run report        # open the last HTML report
```

## Layout

```
playwright.config.ts      projects (setup, ui-chromium, api), reporters, baseURLs
src/
  config/env.ts           the only place env vars are read
  config/auth.ts          storage-state path + SIGNED_OUT helper
  data/                   demo users, checkout customer
  pages/                  one page object per page
  components/             HeaderComponent (shared across signed-in pages)
  fixtures/test.ts        typed, test-scoped page-object fixtures
tests/
  setup/auth.setup.ts     signs in once, saves .auth/standard-user.json
  ui/                     login, inventory, checkout specs
  api/                    posts API specs (native APIRequestContext)
docs/ARCHITECTURE.md      design decisions and the Phase 1 review gate
```

## Writing a test

```ts
import { test, expect } from '../../src/fixtures/test';

test('adds an item', async ({ inventoryPage }) => {
  await inventoryPage.goto();
  await inventoryPage.addToCart('Sauce Labs Backpack');
  await expect(inventoryPage.header.cartBadge).toHaveText('1');
});
```

- Arrange and act through page objects; **assert in the test**.
- UI tests start signed in. Add `test.use({ storageState: SIGNED_OUT })` for signed-out scenarios.
- Prefer `getByRole` / `getByPlaceholder` / `getByTestId` (`data-test` on this site). Don't use fixed waits.

## Execution evidence

Every run writes:

- `playwright-report/`: HTML report, with traces and screenshots for failures
- `test-results/results.json`: machine-readable results
- `test-results/junit.xml`: for CI dashboards

CI (`.github/workflows/playwright.yml`) type-checks, runs the suite, and uploads these as the `playwright-evidence` artifact.
