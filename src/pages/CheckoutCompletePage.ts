import type { Locator, Page } from '@playwright/test';

export class CheckoutCompletePage {
  readonly heading: Locator;
  readonly backHomeButton: Locator;

  constructor(page: Page) {
    this.heading = page.getByRole('heading', { name: 'Thank you for your order!' });
    this.backHomeButton = page.getByRole('button', { name: 'Back Home' });
  }
}
