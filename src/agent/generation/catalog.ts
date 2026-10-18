/**
 * The page-object vocabulary the agent may use, mirroring the fixtures in
 * src/fixtures/test.ts. Generated tests can only call what is listed here.
 * tests/agent/catalog.spec.ts checks that every entry exists on the real
 * page objects, so this file cannot silently drift from them.
 */
export type ParamType = 'string' | 'customer' | 'sortOption';

export interface MethodSpec {
  params: ParamType[];
  description: string;
}

export interface FixtureSpec {
  className: string;
  path: string;
  methods: Record<string, MethodSpec>;
  /** Locator members (dot paths for composed components, e.g. header.cartBadge). */
  locators: Record<string, string>;
}

export const SORT_OPTIONS = ['az', 'za', 'lohi', 'hilo'] as const;

export const CATALOG: Record<string, FixtureSpec> = {
  loginPage: {
    className: 'LoginPage',
    path: '/',
    methods: {
      goto: { params: [], description: 'open the login page' },
      login: { params: ['string', 'string'], description: 'fill username and password, click Login' },
    },
    locators: {
      usernameInput: 'username field',
      passwordInput: 'password field',
      loginButton: 'Login button',
      errorMessage: 'error alert shown after a failed login or a blocked page',
    },
  },
  inventoryPage: {
    className: 'InventoryPage',
    path: '/inventory.html',
    methods: {
      goto: { params: [], description: 'open the product list (requires a signed-in session)' },
      addToCart: { params: ['string'], description: 'click "Add to cart" for the product with this exact name' },
      removeFromCart: { params: ['string'], description: 'click "Remove" for the product with this exact name' },
      sortBy: { params: ['sortOption'], description: 'choose a sort order: az | za | lohi | hilo' },
      'header.openCart': { params: [], description: 'click the cart icon' },
      'header.logout': { params: [], description: 'open the side menu and click Logout' },
    },
    locators: {
      title: 'page title ("Products")',
      items: 'all product rows',
      itemNames: 'product names in display order',
      itemPrices: 'product prices in display order, formatted like $9.99',
      'header.cartBadge': 'number badge on the cart icon (absent when the cart is empty)',
      'header.cartLink': 'cart icon link',
    },
  },
  cartPage: {
    className: 'CartPage',
    path: '/cart.html',
    methods: {
      checkout: { params: [], description: 'click Checkout' },
      'header.openCart': { params: [], description: 'click the cart icon' },
      'header.logout': { params: [], description: 'open the side menu and click Logout' },
    },
    locators: {
      itemNames: 'names of products in the cart',
      checkoutButton: 'Checkout button',
      'header.cartBadge': 'number badge on the cart icon',
    },
  },
  checkoutInformationPage: {
    className: 'CheckoutInformationPage',
    path: '/checkout-step-one.html',
    methods: {
      submit: { params: ['customer'], description: 'fill customer details (some may be omitted) and click Continue' },
    },
    locators: {
      firstNameInput: 'first name field',
      lastNameInput: 'last name field',
      postalCodeInput: 'postal code field',
      errorMessage: 'validation error alert',
    },
  },
  checkoutOverviewPage: {
    className: 'CheckoutOverviewPage',
    path: '/checkout-step-two.html',
    methods: {
      finish: { params: [], description: 'click Finish' },
    },
    locators: {
      itemNames: 'names of products in the order',
      subtotalLabel: 'text like "Item total: $37.98"',
      taxLabel: 'text like "Tax: $3.04"',
      totalLabel: 'text like "Total: $41.02"',
    },
  },
  checkoutCompletePage: {
    className: 'CheckoutCompletePage',
    path: '/checkout-complete.html',
    methods: {},
    locators: {
      heading: 'the "Thank you for your order!" heading',
      backHomeButton: 'Back Home button',
    },
  },
};

export function splitTarget(target: string): { fixture: string; member: string } | undefined {
  const dot = target.indexOf('.');
  if (dot <= 0) return undefined;
  return { fixture: target.slice(0, dot), member: target.slice(dot + 1) };
}
