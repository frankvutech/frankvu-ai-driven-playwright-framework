import { test, expect } from '../../src/fixtures/test';

test.describe('Inventory', () => {
  test.beforeEach(async ({ inventoryPage }) => {
    await inventoryPage.goto();
  });

  test('lists all six products', async ({ inventoryPage }) => {
    await expect(inventoryPage.items).toHaveCount(6);
  });

  test('sorts by price, low to high', async ({ inventoryPage }) => {
    await inventoryPage.sortBy('lohi');

    await expect(inventoryPage.itemPrices).toHaveText([
      '$7.99',
      '$9.99',
      '$15.99',
      '$15.99',
      '$29.99',
      '$49.99',
    ]);
  });

  test('sorts by name, Z to A', async ({ inventoryPage }) => {
    await inventoryPage.sortBy('za');

    await expect(inventoryPage.itemNames.first()).toHaveText('Test.allTheThings() T-Shirt (Red)');
    await expect(inventoryPage.itemNames.last()).toHaveText('Sauce Labs Backpack');
  });

  test('cart badge tracks added and removed items', async ({ inventoryPage }) => {
    await inventoryPage.addToCart('Sauce Labs Backpack');
    await inventoryPage.addToCart('Sauce Labs Bike Light');
    await expect(inventoryPage.header.cartBadge).toHaveText('2');

    await inventoryPage.removeFromCart('Sauce Labs Backpack');
    await expect(inventoryPage.header.cartBadge).toHaveText('1');
  });

  test('logout returns to the login page', async ({ page, inventoryPage, loginPage }) => {
    await inventoryPage.header.logout();

    await expect(loginPage.loginButton).toBeVisible();
    await expect(page).not.toHaveURL(/inventory\.html/);
  });
});
