import path from 'node:path';
import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * Playwright config used only by the Relynx execution adapter
 * (src/agent/execution/adapter.ts). It refuses to load unless the adapter
 * passes the list of approved files, and it matches nothing else.
 * `npx playwright test` with the default config never runs generated code.
 */
const approved: unknown = JSON.parse(process.env.RELYNX_APPROVED_FILES ?? 'null');
const resultsFile = process.env.RELYNX_RESULTS_FILE;
const outputDir = process.env.RELYNX_OUTPUT_DIR;
const runsRoot = path.resolve(__dirname, '.relynx/runs') + path.sep;
const generatedRoot = path.resolve(__dirname, 'generated') + path.sep;

if (!Array.isArray(approved) || approved.length === 0 || !approved.every((f) => typeof f === 'string')) {
  throw new Error('playwright.agent.config.ts only runs files approved through the Relynx execution adapter');
}
const approvedAbs = (approved as string[]).map((f) => path.resolve(__dirname, f));
if (!approvedAbs.every((f) => f.startsWith(generatedRoot) && f.endsWith('.spec.ts'))) {
  throw new Error('approved files must be .spec.ts files inside generated/');
}
for (const p of [resultsFile, outputDir]) {
  if (!p || !path.resolve(p).startsWith(runsRoot)) throw new Error('results and output paths must be inside .relynx/runs/');
}

const sessionUser = process.env.RELYNX_SESSION_USER ?? 'standard';
if (!['standard', 'problem', 'error'].includes(sessionUser)) throw new Error(`unknown session variant ${sessionUser}`);
// Session state lives inside the run directory, never in the shared .auth/ folder.
const sessionState = path.join(path.resolve(outputDir!), '..', 'session-state.json');
process.env.RELYNX_SESSION_STATE = sessionState;

const project = (name: string) => {
  const found = base.projects?.find((p) => p.name === name);
  if (!found) throw new Error(`base config has no project ${name}`);
  return found;
};

export default defineConfig({
  ...base,
  reporter: [['json', { outputFile: resultsFile }]],
  outputDir,
  retries: 0,
  use: { ...base.use, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    {
      ...project('setup'),
      name: 'agent-setup',
      testMatch: /session\.agent-setup\.ts$/,
    },
    {
      ...project('ui-chromium'),
      name: 'agent-generated',
      testDir: './generated',
      dependencies: ['agent-setup'],
      use: { ...project('ui-chromium').use, storageState: sessionState },
      testMatch: approvedAbs.map((f) => new RegExp(`^${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)),
    },
  ],
});
