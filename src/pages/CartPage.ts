import type { Locator, Page } from '@playwright/test';
import { HeaderComponent } from '../components/HeaderComponent';

export class CartPage {
  readonly header: HeaderComponent;
  readonly itemNames: Locator;
  readonly checkoutButton: Locator;

  constructor(page: Page) {
    this.header = new HeaderComponent(page);
    this.itemNames = page.getByTestId('cart-list').getByTestId('inventory-item-name');
    this.checkoutButton = page.getByRole('button', { name: 'Checkout' });
  }

  async checkout(): Promise<void> {
    await this.checkoutButton.click();
  }
}
