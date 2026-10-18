import type { Locator, Page } from '@playwright/test';

/**
 * Primary header shown on every signed-in page: cart link, cart badge and
 * the burger side menu. Pages compose it rather than inherit it.
 */
export class HeaderComponent {
  readonly cartLink: Locator;
  readonly cartBadge: Locator;
  readonly openMenuButton: Locator;
  readonly logoutLink: Locator;

  constructor(page: Page) {
    const root = page.getByTestId('primary-header');
    this.cartLink = root.getByTestId('shopping-cart-link');
    this.cartBadge = root.getByTestId('shopping-cart-badge');
    this.openMenuButton = root.getByRole('button', { name: 'Open Menu' });
    this.logoutLink = root.getByRole('button', { name: 'Logout' });
  }

  async openCart(): Promise<void> {
    await this.cartLink.click();
  }

  async logout(): Promise<void> {
    await this.openMenuButton.click();
    await this.logoutLink.click();
  }
}
