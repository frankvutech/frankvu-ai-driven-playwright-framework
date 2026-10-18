/**
 * Single place where environment-specific values are resolved.
 * Page objects never read these directly; they navigate with relative paths
 * and rely on `baseURL` from playwright.config.ts.
 */
export const env = {
  uiBaseUrl: process.env.UI_BASE_URL ?? 'https://www.saucedemo.com',
  apiBaseUrl: process.env.API_BASE_URL ?? 'https://jsonplaceholder.typicode.com',
} as const;
