export interface CustomerInfo {
  firstName: string;
  lastName: string;
  postalCode: string;
}

export const defaultCustomer: CustomerInfo = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  postalCode: '10115',
};
