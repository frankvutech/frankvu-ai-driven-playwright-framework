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
import { promoteRun } from './workflow/promote';
import { approveHeal, healTest, listHeals, readHealRecord } from './healing/heal';
import type { HealTarget } from './healing/types';

const repoRoot = path.resolve(__dirname, '../..');

const USAGE = `AI Test Agent

  agent generate --requirement <file.json> --provider anthropic|mock [--mock-replies <file.json>]
  agent approve  <runId> --approver "<your name>"        (interactive terminal only)
  agent reject   <runId> --approver "<your name>" --reason "<why>"
  agent execute  <runId> [--analysis-provider anthropic|mock] [--mock-replies <file.json>]
  agent report   <runId>
  agent list
  agent promote  <runId> --approver "<your name>"        (interactive terminal only; passed tests only)

  agent heal --run <runId> --scenario <scenarioId> --provider anthropic|mock [--mock-replies <file.json>]
  agent heal --test <tests/...spec.ts> --title "<exact test title>" --provider anthropic|mock [--mock-replies <file.json>]
             [--example-app-variant <name>] [--session-variant <name>]
  agent heal-approve <healId> --approver "<your name>"   (interactive terminal only; never applies the patch)
  agent heals
`;

/** Ask the person at the terminal to type a confirmation code. */
async function confirm(prompt: string, code: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('this command needs an interactive terminal: a person must confirm it');
  }
  process.stdout.write(`${prompt}\nType "${code}" to confirm: `);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('')).trim();
  rl.close();
  return answer === code;
}

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
      run: { type: 'string' },
      scenario: { type: 'string' },
      test: { type: 'string' },
      title: { type: 'string' },
      'example-app-variant': { type: 'string' },
      'session-variant': { type: 'string' },
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
    case 'promote': {
      const s = store();
      if (!values.approver) throw new Error('--approver "<your name>" is required');
      const passed = s.manifest().artifacts.filter((a) => a.state === 'passed');
      if (passed.length === 0) throw new Error(`run ${runId} has no passed tests to promote`);
      const digest = createHash('sha256').update(passed.map((a) => a.sha256).join('\n')).digest('hex').slice(0, 8);
      const list = passed.map((a) => `  ${a.file}`).join('\n');
      if (!(await confirm(`Promote ${passed.length} passed test(s) of run ${runId} into the trusted suite (tests/*/generated/):\n${list}`, `promote ${digest}`))) {
        process.stdout.write('not confirmed; nothing changed\n');
        return 1;
      }
      const result = await promoteRun(s, values.approver);
      for (const p of result.promoted) process.stdout.write(`  promoted ${p.scenarioId} -> ${p.file}\n`);
      for (const k of result.skipped) process.stdout.write(`  skipped  ${k.scenarioId}: ${k.reason}\n`);
      process.stdout.write('Nothing was committed. Review the new files and commit them yourself.\n');
      return result.promoted.length > 0 ? 0 : 1;
    }
    case 'heal': {
      let target: HealTarget;
      if (values.run && values.scenario) target = { kind: 'generated', runId: values.run, scenarioId: values.scenario };
      else if (values.test && values.title) target = { kind: 'trusted', file: values.test, title: values.title };
      else throw new Error('heal needs --run <runId> --scenario <id>, or --test <file> --title "<title>"');
      const provider = createProvider(values.provider, values['mock-replies']);
      const record = await healTest(target, {
        repoRoot,
        policy,
        env: process.env,
        provider,
        exampleAppVariant: values['example-app-variant'],
        sessionVariant: values['session-variant'],
      });
      process.stdout.write(`heal ${record.healId}: ${record.outcome}\n  ${record.history[record.history.length - 1]?.reason ?? ''}\n`);
      process.stdout.write(`report: ${path.join('.agent/heals', record.healId, 'heal-report.md')}\n`);
      if (record.outcome === 'verified_pending_review') {
        process.stdout.write(`\nReview ${record.patch!.file}, then record your decision:\n  npm run agent -- heal-approve ${record.healId} --approver "<your name>"\n`);
      }
      return record.outcome === 'verified_pending_review' ? 0 : 2;
    }
    case 'heal-approve': {
      if (!runId) throw new Error('heal-approve needs a heal id');
      if (!values.approver) throw new Error('--approver "<your name>" is required');
      const record = readHealRecord(repoRoot, runId);
      if (!record.patch) throw new Error(`heal ${runId} has no patch (${record.outcome})`);
      const code = `approve ${record.patch.sha256.slice(0, 8)}`;
      if (!(await confirm(`Heal ${runId} changes ${record.patch.changedFiles.join(', ')}.\nApproving records your decision only; the patch is not applied, committed or pushed.`, code))) {
        process.stdout.write('not confirmed; nothing changed\n');
        return 1;
      }
      const approved = approveHeal(repoRoot, runId, values.approver);
      process.stdout.write(`approved. Apply it yourself after review:\n  git apply ${approved.patch!.file}\n`);
      return 0;
    }
    case 'heals': {
      for (const h of listHeals(repoRoot)) process.stdout.write(`${h.healId}  ${h.outcome}\n`);
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
