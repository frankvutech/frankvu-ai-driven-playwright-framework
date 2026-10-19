/**
 * Applications the agent can plan and generate tests for, and the test layers
 * each one supports. Generation is limited to what the framework already has
 * page objects or API clients for; anything else is reported, not invented.
 */
export const LAYERS = ['ui', 'api', 'combined'] as const;
export type Layer = (typeof LAYERS)[number];

export const APPLICATIONS = {
  storefront: {
    description: 'saucedemo.com e-commerce demo: login, product list, cart, checkout (UI only; it has no API)',
    layers: ['ui'],
  },
  notes: {
    description:
      'local example notes app (example-app/): server-rendered sign-in and notes pages, plus a JSON REST API under /api with bearer-token auth',
    layers: ['ui', 'api', 'combined'],
  },
  posts: {
    description: 'JSONPlaceholder public fake REST API /posts (no auth; writes are echoed back, never persisted)',
    layers: ['api'],
  },
} as const satisfies Record<string, { description: string; layers: readonly Layer[] }>;

export type ApplicationId = keyof typeof APPLICATIONS;
export const APPLICATION_IDS = Object.keys(APPLICATIONS) as [ApplicationId, ...ApplicationId[]];

export function supportsLayer(app: ApplicationId, layer: Layer): boolean {
  return (APPLICATIONS[app].layers as readonly Layer[]).includes(layer);
}
