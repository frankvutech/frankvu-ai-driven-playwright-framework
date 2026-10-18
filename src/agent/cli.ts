import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { createProvider } from './config/llm';
import { loadPolicy } from './execution/policy';
import { planAndGenerate } from './workflow/generate';
import { recordDecision } from './workflow/decide';
import { executeRun } from './workflow/execute';
import { RunStore } from './workflow/store';

const repoRoot = path.resolve(__dirname, '../..');

const USAGE = `Relynx AI Test Agent

  relynx generate --requirement <file.json> --provider anthropic|mock [--mock-replies <file.json>]
  relynx approve  <runId> --approver "<your name>"        (interactive terminal only)
  relynx reject   <runId> --approver "<your name>" --reason "<why>"
  relynx execute  <runId> [--analysis-provider anthropic|mock] [--mock-replies <file.json>]
  relynx report   <runId>
  relynx list
`;

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      requirement: { type: 'string' },
      provider: { type: 'string' },
      'analysis-provider': { type: 'string' },
      'mock-replies': { type: 'string' },
      approver: { type: 'string' },
      reason: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  const [command, runId] = positionals;
  if (!command || values.help) {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }
  const policy = loadPolicy(repoRoot);
  const store = () => {
    if (!runId) throw new Error(`${command} needs a run id`);
    return new RunStore(repoRoot, policy.runsArea, runId);
  };

  switch (command) {
    case 'generate': {
      if (!values.requirement) throw new Error('--requirement is required');
      const input = JSON.parse(readFileSync(values.requirement, 'utf8'));
      const provider = createProvider(values.provider, values['mock-replies']);
      const manifest = await planAndGenerate(input, { repoRoot, policy, provider });
      const s = new RunStore(repoRoot, policy.runsArea, manifest.runId);
      process.stdout.write(`run ${manifest.runId}: ${manifest.status}\nreport: ${path.relative(repoRoot, path.join(s.runDir, 'report.md'))}\n`);
      for (const a of manifest.artifacts) process.stdout.write(`  ${a.state.padEnd(18)} ${a.file}\n`);
      if (manifest.status === 'awaiting_approval') {
        process.stdout.write(`\nReview the files above, then run:\n  npm run agent -- approve ${manifest.runId} --approver "<your name>"\n`);
      }
      return ['awaiting_approval', 'nothing_to_execute', 'needs_clarification'].includes(manifest.status) ? 0 : 2;
    }
    case 'approve':
    case 'reject': {
      const s = store();
      if (!values.approver) throw new Error('--approver "<your name>" is required');
      const manifest = s.manifest();
      const pending = manifest.artifacts.filter((a) => a.state === 'awaiting_approval');
      if (command === 'reject') {
        if (!values.reason) throw new Error('--reason is required when rejecting');
        recordDecision(s, 'rejected', values.approver, values.reason);
        process.stdout.write(`run ${runId} rejected\n`);
        return 0;
      }
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error('approval needs an interactive terminal: a person must confirm it');
      }
      const digest = createHash('sha256').update(pending.map((a) => a.sha256).join('\n')).digest('hex').slice(0, 8);
      process.stdout.write(`Run ${runId} — ${pending.length} artifact(s) awaiting approval:\n`);
      for (const a of pending) process.stdout.write(`  ${a.file}  sha256 ${a.sha256.slice(0, 16)}…\n`);
      process.stdout.write(`\nApproving lets these files run against the approved test target.\nType "approve ${digest}" to confirm: `);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question('')).trim();
      rl.close();
      if (answer !== `approve ${digest}`) {
        process.stdout.write('not confirmed; nothing changed\n');
        return 1;
      }
      recordDecision(s, 'approved', values.approver, 'approved after interactive review');
      process.stdout.write(`approved. Execute with:\n  npm run agent -- execute ${runId}\n`);
      return 0;
    }
    case 'execute': {
      const s = store();
      const analysisProvider = values['analysis-provider'] ? createProvider(values['analysis-provider'], values['mock-replies']) : undefined;
      const manifest = await executeRun(s, { policy, env: process.env, analysisProvider });
      process.stdout.write(`run ${runId}: ${manifest.status}\n`);
      for (const a of manifest.artifacts) process.stdout.write(`  ${a.state.padEnd(18)} ${a.file}\n`);
      process.stdout.write(`report: ${path.relative(repoRoot, path.join(s.runDir, 'report.md'))}\n`);
      if (manifest.status !== 'executed') return 2;
      return manifest.artifacts.some((a) => a.state === 'failed' || a.state === 'inconclusive') ? 1 : 0;
    }
    case 'report': {
      process.stdout.write(readFileSync(path.join(store().runDir, 'report.md'), 'utf8'));
      return 0;
    }
    case 'list': {
      const dir = path.join(repoRoot, policy.runsArea);
      if (!existsSync(dir)) return 0;
      for (const id of readdirSync(dir).sort()) {
        try {
          process.stdout.write(`${id}  ${new RunStore(repoRoot, policy.runsArea, id).manifest().status}\n`);
        } catch {
          /* not a run directory */
        }
      }
      return 0;
    }
    default:
      process.stdout.write(USAGE);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
