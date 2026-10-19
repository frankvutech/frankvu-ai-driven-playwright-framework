import { env } from '../src/config/env';
import { exampleAppUsers } from '../src/data/exampleApp';
import { startExampleApp } from './server';

/**
 * Runs the example app by hand (npm run example-app) for exploring it or for
 * pointing EXAMPLE_APP_URL at it. Tests do not need this; they start their own.
 */
async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 4010);
  const app = await startExampleApp({ users: Object.values(exampleAppUsers), port });
  const passwordSource = env.exampleAppPassword === 'example-app-pass' ? 'the default' : 'EXAMPLE_APP_PASSWORD';
  console.log(`Example app listening on ${app.url} (users: ${Object.keys(exampleAppUsers).join(', ')}; password: ${passwordSource})`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void app.close().then(() => process.exit(0)));
}

void main();
