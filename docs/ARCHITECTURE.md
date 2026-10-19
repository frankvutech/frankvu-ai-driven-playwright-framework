# Architecture — Phase 1 (framework foundation)

## Decision

UI automation uses the **Page Object Model**. Playwright Test fixtures provide the page objects, and component objects cover parts that recur on several pages. API automation uses Playwright's `APIRequestContext` through small **resource clients**, and **zod schemas** validate response bodies. UI + API workflows combine both through fixtures that point at the same application. **The Screenplay Pattern is not used.** POM and Screenplay are not mixed.

### Why POM fits this repository

- The main UI under test is a small, page-oriented storefront with a linear flow: login → inventory → cart → checkout step 1 → step 2 → complete. One class per page maps directly onto it. The example app has two pages.
- The UI surface is small, so Screenplay's actors, tasks and questions would add indirection with no payoff.
- Page objects keep locators in one place, and tests stay readable as *arrange → act → assert*. This structure is also easy for a reviewer or an AI agent to follow.

## Targets

| Target | Used for | Why |
|--------|----------|-----|
| saucedemo.com (public) | UI suite | Stable `data-test` attributes, realistic flows. It has no API. |
| jsonplaceholder.typicode.com (public) | API: HTTP methods, status, headers, schema | No auth, and writes are echoed but not persisted. |
| `example-app/` (local, in this repo) | API auth (401/403), stateful CRUD, validation boundaries, UI + API workflows | Neither public target offers auth or one app with both UI and API. The spec asked for a clearly labelled local example in that case instead of invented endpoints. |

The example app is about 300 lines of Node `http` with no dependencies. It keeps its state in memory and gets its users from the caller. A **worker-scoped fixture** starts it on a random port, once per worker, so there is no global server, no port clash, and no state shared between workers. `EXAMPLE_APP_URL` switches the same tests to a deployed copy (verified with 4 workers sharing one instance).

## Responsibilities

| # | Responsibility | Where |
|---|----------------|-------|
| 1 | Scenario and assertions | `tests/**/*.spec.ts` |
| 2 | Page and component interactions | `src/pages/**`, `src/components/*` |
| 3 | API requests and response contracts | `src/api/*Client.ts`, `src/api/schemas.ts`, `src/api/response.ts` |
| 4 | Setup, teardown, auth, test-data cleanup | `src/fixtures/{test,api,integration}.ts`, `tests/setup/auth.setup.ts` |
| 5 | Configuration | `src/config/env.ts` (validated), `.env.example`, `playwright.config.ts` |
| 6 | Test data | `src/data/*` (constants and one builder) |
| 7 | Execution and reporting | Playwright Test runner and built-in reporters (no custom runner) |
| 8 | Structured execution evidence | `test-results/results.json`, `test-results/junit.xml`, `playwright-report/`, traces, screenshots |

## Patterns implemented

| Pattern | Files | Why |
|---------|-------|-----|
| Page Object Model | `src/pages/*.ts` (saucedemo), `src/pages/example-app/*.ts` | Each page has its own URL and behavior. Page objects expose locators plus intention-revealing actions (`login()`, `addToCart()`, `addNote()`, `signIn()`). They contain no `expect`. |
| Component Object | `src/components/HeaderComponent.ts` | The cart link, badge and burger menu appear on every signed-in saucedemo page. Pages compose it (`page.header`) instead of inheriting it. The example app has no repeated component, so it has none. |
| Playwright fixtures (composed) | `src/fixtures/test.ts` → `agent.ts`; `src/fixtures/api.ts` → `integration.ts` | Typed fixtures with deterministic setup and teardown. Each layer `extend`s the one below it. There is no base class and no DI container. |
| Worker-scoped app fixture | `exampleAppUrl` in `src/fixtures/api.ts` | Starts and stops one example app per worker, or uses `EXAMPLE_APP_URL`. |
| API resource client | `src/api/PostsClient.ts`, `src/api/NotesClient.ts` | Several specs share base URL, auth headers and paths. Methods return the raw `APIResponse`, so status and header assertions stay in the test. Auth belongs to the request context the fixture builds, not to the client. |
| Schema validation | `src/api/schemas.ts`, `parseJson()` in `src/api/response.ts` | zod was already a dependency, so this adds none. Schemas are strict for our own API and loose for the third-party one. Errors name the request and the schema problem but never include the body. |
| Test-data builder | `src/data/notes.ts` (`buildNote`) | Every note test needs a payload with the test's unique prefix. One function, not a builder class. |
| Setup project + storage state | `tests/setup/auth.setup.ts`, `src/config/auth.ts` | saucedemo keeps the session in a cookie. The suite signs in once, and each UI test starts from a fresh context loaded from that file. |
| Sign-in through the API for UI tests | `signInBrowser` in `src/fixtures/integration.ts` | `page.request` shares the browser's cookie jar. A form POST signs the browser in without UI steps, and the UI sign-in itself is covered by its own test. |
| Agent fixtures (Phase 2) | `src/fixtures/agent.ts` | Extends each fixture family (`test.ts`, `api.ts`, `integration.ts`) for generated tests. The browser families get a network guard. |

### Test isolation and cleanup

- Fixtures are test-scoped except the example app, which is worker-scoped. Each test gets a new browser context and new request contexts, all disposed in teardown.
- Example-app data: `testPrefix` is unique per test and per `--repeat-each` index. `exampleAppApi` deletes notes with that prefix **before** the test (leftovers of an interrupted run) and **after** it. This also covers notes created through the UI. Verified: `--repeat-each=3` passed 126/126. A run against one shared external instance with 4 workers left 0 notes behind.
- saucedemo: the cart lives in localStorage of a fresh context. The only shared artifact is the read-only storage-state file written by `setup`.

### Introduced deliberately: none of these

- **BasePage / BaseClient**: none. Pages share only the header, which composition handles. The two clients share no logic beyond `APIRequestContext` itself.
- **Generic HTTP wrapper or repository abstraction**: none. Clients are thin, and per-resource methods call `request.get/post/put/patch/delete`.
- **Factory / Strategy / DI container / service locator / singletons**: none.
- **Browser-tool or MCP interface**: none (see below).
- **Additional reporters (Allure etc.)**: none. The built-in HTML, JSON and JUnit reporters plus traces cover the requirements.
- **dotenv**: none. `node:util` `parseEnv` reads `.env`.

## Configuration

`src/config/env.ts` is the only Phase 1 code that reads environment variables. It validates them with zod and fails fast with messages that name the variable but not the value. It reads only known keys from `.env` and never copies that file into `process.env`. This matters because the Phase 2 execution adapter passes an allow-listed environment to child processes. Loading `.env` wholesale would bypass that allow-list.

Browser projects are generated from `UI_BROWSERS` (`ui-chromium` / `ui-firefox` / `ui-webkit`). Defaults: test 30 s, expect 5 s, action 10 s, navigation 15 s. `retries` is 1 in CI and 0 locally, so a flaky test shows up locally instead of being hidden. CI uses 2 workers, and `fullyParallel` is on.

## Future AI and MCP boundary

Nothing MCP-related is implemented, and the framework does not need it. The boundary is kept this way:

- **Deterministic execution stays the Playwright Test runner.** Tests and fixtures do not depend on any browser-exploration tool. An ESLint rule forbids importing `@playwright/mcp` or `@modelcontextprotocol/*` from `src/`, `tests/` and `example-app/`.
- A future exploration tool (such as Playwright MCP driving a browser for an agent) belongs **outside** the test run. Its outputs, such as proposed locators, page-object changes or test code, enter the repository only as files that go through the same review, `typecheck`, lint and CI gates as human-written code.
- The seams such a tool would use already exist: page objects as the vocabulary, fixtures for setup, and JSON/JUnit results to read. No browser-tool interface was added, because nothing in the codebase would consume one yet.

## Review gate checklist

- [x] **POM justified.** See "Why POM fits" above.
- [x] **Every pattern listed with its files.** See the table above.
- [x] **No Screenplay.** No actors, tasks, questions or abilities anywhere in `src/` or `tests/`.
- [x] **Assertions visible in tests.** Page objects and API clients contain no `expect`. Fixtures throw plain errors only when setup cannot proceed (token request or browser sign-in failed). The one assertion outside a spec is in `auth.setup.ts`, which confirms the login before saving state.
- [x] **No cross-test leakage.** See "Test isolation and cleanup".
- [x] **Environment values isolated.** `src/config/env.ts` is the single reader for Phase 1 code. Phase 2 agent configuration lives in `src/agent/config/llm.ts`.
- [x] **No fixed waits.** All waiting comes from locator auto-waiting and web-first assertions.
- [x] **No MCP and no new AI code in Phase 1.**

## AI-agent rules (unchanged)

- An agent never decides that a test passed. Only a real runner execution counts, as recorded in `results.json` or `junit.xml` and in CI.
- Agent-generated specs go through the same review, `typecheck` and CI gates as human-written ones. They are never executed with production credentials or privileged access without explicit authorization.
- If a stable interface is needed later (for example "run these specs and return results"), add it as an Adapter at that point, over the existing runner, not in place of it.
