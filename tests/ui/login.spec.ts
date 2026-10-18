import { test, expect } from '../../src/fixtures/test';
import { SIGNED_OUT } from '../../src/config/auth';
import { users } from '../../src/data/users';

test.use({ storageState: SIGNED_OUT });

test.describe('Login', () => {
  test.beforeEach(async ({ loginPage }) => {
    await loginPage.goto();
  });

  test('standard user lands on the product list', async ({ page, loginPage, inventoryPage }) => {
    await loginPage.login(users.standard.username, users.standard.password);

    await expect(page).toHaveURL(/inventory\.html/);
    await expect(inventoryPage.title).toHaveText('Products');
  });

  test('locked-out user sees an error and stays on the login page', async ({ page, loginPage }) => {
    await loginPage.login(users.lockedOut.username, users.lockedOut.password);

    await expect(loginPage.errorMessage).toContainText('this user has been locked out');
    await expect(page).not.toHaveURL(/inventory\.html/);
  });

  test('wrong password is rejected', async ({ loginPage }) => {
    await loginPage.login(users.standard.username, 'not-the-password');

    await expect(loginPage.errorMessage).toContainText(
      'Username and password do not match any user in this service',
    );
  });

  test('protected page redirects anonymous visitors to login', async ({ page, loginPage }) => {
    await page.goto('/inventory.html');

    await expect(loginPage.errorMessage).toContainText(
      "You can only access '/inventory.html' when you are logged in",
    );
  });
});
