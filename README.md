# AI-Driven Playwright Framework

Playwright Test + TypeScript framework for **UI, API and combined UI + API testing**, built on the **Page Object Model** (Phase 1). The repository also contains the **AI Test Agent** (Phase 2) and its **evaluation system** (Phase 3). The agent turns requirements into candidate UI, API and combined tests that run only after a person approves them. For failures caused by the test itself, it proposes minimal repairs that are verified in a separate workspace and delivered as patches for review. See [docs/PHASE2_AGENT.md](docs/PHASE2_AGENT.md) and [docs/PHASE3_EVALUATION.md](docs/PHASE3_EVALUATION.md).

| Suite | Target | Default (override with env var) |
|-------|--------|----------------------------------|
| UI (`tests/ui`) | Sauce Demo storefront (public) | `https://www.saucedemo.com` (`UI_BASE_URL`) |
| API (`tests/api/posts.spec.ts`) | JSONPlaceholder REST API (public, no auth, writes not persisted) | `https://jsonplaceholder.typicode.com` (`API_BASE_URL`) |
| API (`tests/api/notes.spec.ts`) and UI + API (`tests/integration`) | **Local example app** in `example-app/` | started by the tests (`EXAMPLE_APP_URL` to use a deployed copy) |

The public targets need internet access and depend on those sites being up. The example app is a small local server written for this repository. It exists only so the framework can verify bearer-token auth (401/403), real create/update/delete with state, and UI + API workflows against one application. It is not a product.

## Quick start

```bash
npm ci
npx playwright install chromium
cp .env.example .env      # optional; every value has a default
npm run typecheck
npm run lint
npm run test:ui           # UI on saucedemo (runs the sign-in setup first)
npm run test:api          # API: JSONPlaceholder + example app
npm run test:integration  # UI + API workflows on the example app
npm run test:framework    # framework self-tests (config validation), no network
npm run report            # open the last HTML report
npm run report:allure:serve # create and open an Allure report from the latest test results
```

`npm test` runs **every** project, including the Phase 2/3 agent and evaluation tests below.

Run a single file, test or browser:

```bash
npx playwright test tests/ui/login.spec.ts
npx playwright test tests/api/notes.spec.ts -g "403"
npx playwright test --project=ui-chromium --headed
UI_BROWSERS=chromium,firefox,webkit npm run test:ui   # after: npx playwright install firefox webkit
```

AI Test Agent (Phase 2) and evaluation (Phase 3):

```bash
npm run test:agent                # agent unit tests (mock provider, fake runners)
npm run test:agent-integration    # real runs: agent workflow, guarded healing, promotion
npm run test:eval                 # evaluation-system tests
npm run eval                      # deterministic evaluation, gated against eval/baselines/
AGENT_EVAL_APPROVER="Your Name" npm run eval:functional   # seeded defects: demo site + local example app
AGENT_EVAL_APPROVER="Your Name" npm run eval:healing      # guarded healing on the local example app (safety gates)
npm run agent -- generate --requirement examples/requirements/REQ-201-notes-api.json --provider mock --mock-replies examples/mock-replies/REQ-201.json
npm run agent -- approve <runId> --approver "Your Name"     # interactive
npm run agent -- execute <runId>
npm run agent -- promote <runId> --approver "Your Name"     # interactive; copies passed tests into tests/*/generated/
npm run agent -- heal --test tests/integration/notes.spec.ts --title "a note added in the UI is returned by the API" \
  --provider mock --mock-replies examples/mock-replies/heal-renamed-add-button.json --example-app-variant renamed-add-button
npm run agent -- heal-approve <healId> --approver "Your Name"   # interactive; records a decision, never applies the patch
```

The agent never applies, commits, pushes or merges anything. See [docs/PHASE2_AGENT.md](docs/PHASE2_AGENT.md) for its boundaries.

## Configuration

All settings are read and validated in `src/config/env.ts`. The order is: real environment variables, then an optional `.env` file, then defaults. Only the keys below are read from `.env`. The file is never loaded into `process.env`, so other secrets kept there do not reach test processes. An invalid value stops the run with a message that names the variable and never echoes the value.

| Variable | Default | Purpose |
|----------|---------|---------|
| `UI_BASE_URL` | `https://www.saucedemo.com` | UI target |
| `API_BASE_URL` | `https://jsonplaceholder.typicode.com` | public API target |
| `EXAMPLE_APP_URL` | unset: each worker starts its own local app | use a deployed example app instead |
| `EXAMPLE_APP_VARIANT` | `standard` | deterministic failure modes of the local app (`renamed-add-button`, `intermittent-slow-list`, `broken-create`), used to verify analysis and healing |
| `UI_BROWSERS` | `chromium` | comma-separated `chromium,firefox,webkit`, giving one `ui-<browser>` project each. The Phase 2 agent needs `chromium`. |
| `SAUCE_PASSWORD` | `secret_sauce` | public demo password published by saucedemo |
| `EXAMPLE_APP_PASSWORD` | `example-app-pass` | password of the example app's test users `alice` and `bob` (min. 8 characters) |

Never commit `.env`; it is git-ignored. In CI, set values as secrets or variables.

## Layout

```
playwright.config.ts        projects, timeouts, retries, reporters, artifacts
.env.example                documented configuration (no secrets)
src/
  config/env.ts             the only place env vars are read; validated with zod
  config/auth.ts            saucedemo storage-state path + SIGNED_OUT helper
  data/                     test data: saucedemo users and customer, example-app users, note builder
  pages/                    saucedemo page objects (one per page)
  pages/example-app/        example-app page objects (sign-in, notes)
  components/               HeaderComponent (shared across signed-in saucedemo pages)
  api/                      API clients (PostsClient, NotesClient), response schemas, parseJson()
  fixtures/test.ts          saucedemo page-object fixtures (UI tests)
  fixtures/api.ts           API clients, example-app lifecycle, auth, test-data cleanup
  fixtures/integration.ts   api.ts + example-app page objects + browser sign-in via API
  fixtures/agent.ts         guarded fixtures for agent-generated tests (storefront, notes, API)
  agent/                    Phase 2 AI Test Agent (generation, execution, analysis, healing)
example-app/                local example application (server.ts) + `npm run example-app`
tests/
  setup/                    signs in to saucedemo once, saves .auth/standard-user.json
  ui/                       saucedemo login, inventory, checkout
  api/                      posts.spec.ts (JSONPlaceholder), notes.spec.ts (example app)
  integration/              UI + API workflows on the example app
  framework/                configuration self-tests
  agent/, agent-integration/  Phase 2 tests
  eval/                     Phase 3 tests
playwright.agent.config.ts  runs approved generated tests only
agent.policy.json           execution and healing policy for the agent (protected; change via review)
eval/                       evaluation dataset and runners
examples/                   sample requirements and hand-written mock replies
docs/ARCHITECTURE.md        Phase 1 design decisions and review gate
docs/PHASE2_AGENT.md        Phase 2 architecture, workflow, security
docs/PHASE3_EVALUATION.md   Phase 3 evaluation methodology, results, limitations
```

## Writing tests

UI (page objects through fixtures):

```ts
import { test, expect } from '../../src/fixtures/test';

test('adds an item', async ({ inventoryPage }) => {
  await inventoryPage.goto();
  await inventoryPage.addToCart('Sauce Labs Backpack');
  await expect(inventoryPage.header.cartBadge).toHaveText('1');
});
```

API (clients return the raw `APIResponse`, so the test asserts the status, headers and body):

```ts
import { test, expect } from '../../src/fixtures/api';
import { parseJson } from '../../src/api/response';
import { NoteSchema } from '../../src/api/schemas';
import { buildNote } from '../../src/data/notes';

test('creates a note', async ({ exampleAppApi, testPrefix }) => {
  const alice = await exampleAppApi.as('alice');
  const response = await alice.create(buildNote(testPrefix));
  expect(response.status()).toBe(201);
  expect((await parseJson(response, NoteSchema)).owner).toBe('alice');
});
```

UI + API: import from `src/fixtures/integration`. Use `exampleAppApi` to arrange or verify state, and `signInBrowser('alice')` to start the browser signed in without UI steps.

Conventions:

- Arrange and act through page objects and clients. **Assert in the test.** Page objects and clients contain no business assertions.
- Locators: `getByRole` / `getByLabel` / `getByPlaceholder` first, then `getByTestId` (`data-test` on both apps). Use web-first assertions; no fixed waits.
- saucedemo UI tests start signed in. Use `test.use({ storageState: SIGNED_OUT })` for signed-out scenarios.
- Example-app data: put `testPrefix` at the start of every title. The `exampleAppApi` fixture deletes the test's notes before and after it, so tests are repeatable, can run in parallel and in any order, and also work against a shared deployed app.
- Validate response bodies with `parseJson(response, Schema)`. Its errors name the request and the schema problem, but never include the body.

## Execution evidence

Every run writes:

- `playwright-report/`: HTML report with traces and screenshots for failures (`trace: retain-on-failure`, `screenshot: only-on-failure`)
- `allure-results/`: Allure raw result files from the primary Playwright config. Generate a static report with `npm run report:allure`, open it with `npm run report:allure:open`, or use `npm run report:allure:serve` to generate and serve the latest results.
- `allure-report/`: generated Allure HTML report. CI uploads both the raw results and the generated report as part of `playwright-evidence`.
- `test-results/results.json`: machine-readable results
- `test-results/junit.xml`: for CI dashboards

Allure is an additional view; Playwright Test remains the execution and pass/fail authority. Allure artifacts may contain the same screenshots, traces, and test details as the existing Playwright artifacts, so treat CI downloads as sensitive.

Traces of API calls include request headers, which can hold the example app's bearer tokens. Those tokens are random, live in memory and expire when the app stops. For real targets, use short-lived test credentials, and treat trace files from CI artifacts as sensitive.

CI (`.github/workflows/playwright.yml`) lints and type-checks. It runs the framework self-tests and the agent and evaluation unit tests, then the baseline-gated deterministic evaluation. Next it runs the UI, API, UI + API integration and agent integration suites, the seeded-defect probe, and the baseline-gated functional and healing evaluations. Threshold gates (including safety gates) are configured in `eval/gates.json`. It uploads the results as the `playwright-evidence` artifact. Live model evaluation is a separate, manual workflow (`live-eval.yml`).
