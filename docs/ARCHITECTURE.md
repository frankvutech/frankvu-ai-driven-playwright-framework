# Architecture — Phase 1

## Decision

UI automation uses the **Page Object Model**. Playwright Test fixtures provide the page objects, and one composable component object handles the shared header. API tests use Playwright's `APIRequestContext` directly. **The Screenplay Pattern is not used.** POM and Screenplay are not mixed.

### Why POM fits this repository

- The repo started empty, and the app under test is a small, page-oriented storefront with a linear flow: login → inventory → cart → checkout step 1 → step 2 → complete. One class per page maps directly onto it.
- The UI surface is small: six pages and one shared header. Screenplay's actors, tasks and questions would add indirection with no payoff at this size.
- Page objects keep locators in one place, and tests stay readable as *arrange → act → assert*. This structure is also easy for a reviewer or a future AI agent to follow.

## Responsibilities

| # | Responsibility | Where |
|---|----------------|-------|
| 1 | Scenario and assertions | `tests/**/*.spec.ts` |
| 2 | Page and component interactions | `src/pages/*`, `src/components/*` |
| 3 | Setup and dependencies | `src/fixtures/test.ts`, `tests/setup/auth.setup.ts`, `playwright.config.ts` projects |
| 4 | Execution and reporting | Playwright Test runner and built-in reporters (no custom runner) |
| 5 | Structured execution evidence | `test-results/results.json`, `test-results/junit.xml`, `playwright-report/`, traces |

## Patterns implemented

| Pattern | Files | Why |
|---------|-------|-----|
| Page Object Model | `src/pages/LoginPage.ts`, `InventoryPage.ts`, `CartPage.ts`, `CheckoutInformationPage.ts`, `CheckoutOverviewPage.ts`, `CheckoutCompletePage.ts` | Each page has its own URL and behavior. Page objects expose locators plus intention-revealing actions such as `login()`, `addToCart()`, `sortBy()`, `checkout()`, `submit()` and `finish()`. |
| Component Object | `src/components/HeaderComponent.ts` | The cart link, cart badge and burger menu (logout) appear on every signed-in page. `InventoryPage` and `CartPage` compose it (`page.header`) instead of inheriting it. |
| Playwright fixtures | `src/fixtures/test.ts` | Typed, **test-scoped** fixtures build page objects from each test's own `page`. This removes `new XPage(page)` boilerplate, adds no shared state, and fixtures are lazy, so unused pages cost nothing. |
| Setup project + storage state | `tests/setup/auth.setup.ts`, `src/config/auth.ts`, `playwright.config.ts` | The site keeps the session in a cookie. The suite signs in once and every UI test starts from a fresh context loaded from that file. Login specs opt out with `SIGNED_OUT`. |

### Introduced deliberately: none of these

- **BasePage**: none. The only behavior shared between pages is the header, and composition handles it.
- **Factory / Strategy / Builder**: none. Object creation does not vary at runtime, and there is one data-provisioning approach. Test data is two small constant objects in `src/data/`; a builder would add nothing.
- **API client**: none. Four API tests call `request.get/post` with a relative path, and `baseURL` comes from the `api` project. Add a client only when several specs share auth, headers or request construction.
- **Adapter / AI-agent integration**: none in Phase 1.
- **Screenplay, custom runner, custom assertions, DI container, service locator, singletons**: none.

## Review gate checklist

- [x] **POM justified.** See "Why POM fits" above.
- [x] **Every pattern listed with its files.** See the table above.
- [x] **No Screenplay.** No actors, tasks, questions or abilities anywhere in `src/` or `tests/`.
- [x] **Unnecessary abstractions removed.** During review, unused members were deleted: the header's `resetAppStateLink`, the cart's `continueShoppingButton` and `CartPage.goto()`, and an `InventoryPage.prices()` parser. The sort tests now assert expected values with auto-retrying `toHaveText`.
- [x] **Assertions visible in tests.** Page objects contain no `expect`. The one assertion outside a spec is in `auth.setup.ts`: it confirms the login worked before saving state.
- [x] **No cross-test leakage.** Fixtures are test-scoped. Each test gets a new browser context, so cookies and localStorage (where the cart lives) never carry over. The only shared artefact is the read-only storage-state file written by `setup`. Verified with `--repeat-each=3 --workers=6`: 46/46 passed.
- [x] **Environment values isolated.** Only `src/config/env.ts` and `src/data/users.ts` read `process.env`. Page objects navigate with relative paths.
- [x] **No fixed waits.** All waiting comes from locator auto-waiting and web-first assertions.

## AI-agent compatibility (future)

The layers above give future AI agents stable seams to work with: specs to generate or select, page objects as the vocabulary, and JSON/JUnit results to read. The rules for that phase:

- An agent never decides that a test passed. Only a real runner execution counts, as recorded in `results.json` or `junit.xml` and in CI.
- Agent-generated specs go through the same review, `typecheck` and CI gates as human-written ones. They are never executed with production credentials or privileged access without explicit authorization.
- If a stable interface is needed later (for example "run these specs and return results"), add it as an Adapter at that point, over the existing runner, not in place of it.
