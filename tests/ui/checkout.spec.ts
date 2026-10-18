import { test, expect } from '../../src/fixtures/test';
import { defaultCustomer } from '../../src/data/customers';

test.describe('Checkout', () => {
  test.beforeEach(async ({ inventoryPage }) => {
    await inventoryPage.goto();
    await inventoryPage.addToCart('Sauce Labs Backpack');
    await inventoryPage.addToCart('Sauce Labs Onesie');
    await inventoryPage.header.openCart();
  });

  test('completes an order with two items', async ({
    cartPage,
    checkoutInformationPage,
    checkoutOverviewPage,
    checkoutCompletePage,
  }) => {
    await expect(cartPage.itemNames).toHaveText(['Sauce Labs Backpack', 'Sauce Labs Onesie']);
    await cartPage.checkout();

    await checkoutInformationPage.submit(defaultCustomer);

    await expect(checkoutOverviewPage.itemNames).toHaveText([
      'Sauce Labs Backpack',
      'Sauce Labs Onesie',
    ]);
    // $29.99 + $7.99; tax is 8% rounded to cents.
    await expect(checkoutOverviewPage.subtotalLabel).toHaveText('Item total: $37.98');
    await expect(checkoutOverviewPage.taxLabel).toHaveText('Tax: $3.04');
    await expect(checkoutOverviewPage.totalLabel).toHaveText('Total: $41.02');

    await checkoutOverviewPage.finish();

    await expect(checkoutCompletePage.heading).toBeVisible();
    await expect(checkoutCompletePage.backHomeButton).toBeVisible();
  });

  test('requires a postal code', async ({ page, cartPage, checkoutInformationPage }) => {
    await cartPage.checkout();

    await checkoutInformationPage.submit({ ...defaultCustomer, postalCode: undefined });

    await expect(checkoutInformationPage.errorMessage).toHaveText('Error: Postal Code is required');
    await expect(page).toHaveURL(/checkout-step-one\.html/);
  });
});
