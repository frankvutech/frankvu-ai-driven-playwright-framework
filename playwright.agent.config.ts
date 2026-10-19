import path from 'node:path';
import { defineConfig, type Project } from '@playwright/test';
import base from './playwright.config';

/**
 * Playwright config used only by the agent execution adapter
 * (src/agent/execution/adapter.ts) and healing verification. It refuses to
 * load unless the adapter passes the list of approved files, and it matches
 * nothing else. `npx playwright test` with the default config never runs
 * generated code.
 *
 * Generated files are split into families by suffix, each with its own
 * project and fixtures: <id>.spec.ts (storefront UI), <id>.notes.spec.ts
 * (example-app UI and UI+API), <id>.api.spec.ts (API only).
 */
const approved: unknown = JSON.parse(process.env.AGENT_APPROVED_FILES ?? 'null');
const resultsFile = process.env.AGENT_RESULTS_FILE;
const outputDir = process.env.AGENT_OUTPUT_DIR;
const runsRoot = path.resolve(__dirname, '.agent') + path.sep;
const generatedRoot = path.resolve(__dirname, 'generated') + path.sep;

if (!Array.isArray(approved) || approved.length === 0 || !approved.every((f) => typeof f === 'string')) {
  throw new Error('playwright.agent.config.ts only runs files approved through the agent execution adapter');
}
const approvedAbs = (approved as string[]).map((f) => path.resolve(__dirname, f));
if (!approvedAbs.every((f) => f.startsWith(generatedRoot) && f.endsWith('.spec.ts'))) {
  throw new Error('approved files must be .spec.ts files inside generated/');
}
for (const p of [resultsFile, outputDir]) {
  if (!p || !path.resolve(p).startsWith(runsRoot)) throw new Error('results and output paths must be inside .agent/');
}

const sessionUser = process.env.AGENT_SESSION_USER ?? 'standard';
if (!['standard', 'problem', 'error'].includes(sessionUser)) throw new Error(`unknown session variant ${sessionUser}`);
// Session state lives inside the run directory, never in the shared .auth/ folder.
const sessionState = path.join(path.resolve(outputDir!), '..', 'session-state.json');
process.env.AGENT_SESSION_STATE = sessionState;

const project = (match: (name: string) => boolean, label: string): Project => {
  const found = base.projects?.find((p) => p.name !== undefined && match(p.name));
  if (!found) throw new Error(`base config has no ${label} project`);
  return found;
};
const uiProject = project((n) => n === 'ui-chromium', 'ui-chromium');
const exact = (files: string[]) => files.map((f) => new RegExp(`^${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));

const notes = approvedAbs.filter((f) => f.endsWith('.notes.spec.ts'));
const api = approvedAbs.filter((f) => f.endsWith('.api.spec.ts'));
const storefront = approvedAbs.filter((f) => !notes.includes(f) && !api.includes(f));

const projects: Project[] = [];
if (storefront.length > 0) {
  projects.push(
    { ...project((n) => n === 'setup', 'setup'), name: 'agent-setup', testMatch: /session\.agent-setup\.ts$/ },
    {
      ...uiProject,
      name: 'agent-generated',
      testDir: './generated',
      dependencies: ['agent-setup'],
      use: { ...uiProject.use, storageState: sessionState },
      testMatch: exact(storefront),
    },
  );
}
if (notes.length > 0) {
  projects.push({ ...project((n) => n === 'integration', 'integration'), name: 'agent-generated-notes', testDir: './generated', testMatch: exact(notes) });
}
if (api.length > 0) {
  projects.push({ ...project((n) => n === 'api', 'api'), name: 'agent-generated-api', testDir: './generated', testMatch: exact(api) });
}

export default defineConfig({
  ...base,
  reporter: [['json', { outputFile: resultsFile }]],
  outputDir,
  retries: 0,
  use: { ...base.use, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects,
});
