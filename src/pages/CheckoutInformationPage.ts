import type { Locator, Page } from '@playwright/test';
import type { CustomerInfo } from '../data/customers';

/** Checkout step one: customer details form. */
export class CheckoutInformationPage {
  readonly firstNameInput: Locator;
  readonly lastNameInput: Locator;
  readonly postalCodeInput: Locator;
  readonly continueButton: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.firstNameInput = page.getByPlaceholder('First Name');
    this.lastNameInput = page.getByPlaceholder('Last Name');
    this.postalCodeInput = page.getByPlaceholder('Zip/Postal Code');
    this.continueButton = page.getByRole('button', { name: 'Continue' });
    this.errorMessage = page.getByRole('alert');
  }

  async submit(customer: Partial<CustomerInfo>): Promise<void> {
    if (customer.firstName !== undefined) await this.firstNameInput.fill(customer.firstName);
    if (customer.lastName !== undefined) await this.lastNameInput.fill(customer.lastName);
    if (customer.postalCode !== undefined) await this.postalCodeInput.fill(customer.postalCode);
    await this.continueButton.click();
  }
}
