import { test, expect } from '@playwright/test';
import { defaultSpawner } from '../../src/agent/execution/adapter';

test.describe('default spawner', () => {
  test('passes arguments without a shell', async () => {
    const result = await defaultSpawner(process.execPath, ['-e', 'console.log(process.argv[1])', '$(touch /tmp/relynx-should-not-exist); echo hi'], {
      cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs: 10_000,
    });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.stdout.trim()).toBe('$(touch /tmp/relynx-should-not-exist); echo hi');
  });

  test('stops the process group at the time limit', async () => {
    // The child starts a grandchild that would outlive a plain child.kill().
    const script = `
      const { spawn } = require('node:child_process');
      const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      console.log(g.pid);
      setInterval(() => {}, 1000);`;
    const result = await defaultSpawner(process.execPath, ['-e', script], { cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs: 1_000 });
    expect(result.timedOut).toBe(true);
    const grandchild = Number(result.stdout.trim());
    await expect.poll(() => {
      try {
        process.kill(grandchild, 0);
        return 'alive';
      } catch {
        return 'gone';
      }
    }, { timeout: 10_000 }).toBe('gone');
  });
});
