# AI-Driven Playwright Framework

Playwright Test + TypeScript framework built on the **Page Object Model** (Phase 1), plus the **Relynx AI Test Agent** (Phase 2). The agent turns requirements into candidate tests that run only after a person approves them. See [docs/PHASE2_AGENT.md](docs/PHASE2_AGENT.md).

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
npm run lint
npm run report        # open the last HTML report

# AI Test Agent (Phase 2)
npm run test:agent                # agent unit tests
npm run test:agent-integration    # full agent workflow against the demo target
npm run eval                      # deterministic evaluation
npm run agent -- generate --requirement examples/requirements/REQ-101-sign-in.json --provider mock --mock-replies examples/mock-replies/REQ-101.json
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
  agent/                  Phase 2 AI Test Agent (see docs/PHASE2_AGENT.md)
  fixtures/agent.ts       fixtures for generated tests (+ network guard)
tests/agent/              agent unit tests
tests/agent-integration/  agent end-to-end tests
playwright.agent.config.ts  runs approved generated tests only
relynx.policy.json        execution policy (protected; change via review)
eval/                     evaluation dataset and runners
examples/                 sample requirements and hand-written mock replies
docs/ARCHITECTURE.md      Phase 1 design decisions and review gate
docs/PHASE2_AGENT.md      Phase 2 architecture, workflow, security, evaluation
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

CI (`.github/workflows/playwright.yml`) lints and type-checks, runs the agent unit tests, the UI/API suites and the agent integration tests, then runs the deterministic evaluation. It uploads the results as the `playwright-evidence` artifact. Live model evaluation is a separate, manual workflow (`live-eval.yml`).
