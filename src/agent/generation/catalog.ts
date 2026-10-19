/**
 * The page-object vocabulary the agent may use, mirroring the fixtures in
 * src/fixtures/test.ts. Generated tests can only call what is listed here.
 * tests/agent/catalog.spec.ts checks that every entry exists on the real
 * page objects, so this file cannot silently drift from them.
 */
/** string: literal or data ref. text: literal or a test-prefixed text (example app titles). */
export type ParamType = 'string' | 'text' | 'customer' | 'sortOption';

export interface MethodSpec {
  params: ParamType[];
  description: string;
}

export interface FixtureSpec {
  className: string;
  path: string;
  /** Repo-relative source file of the page object. */
  source: string;
  methods: Record<string, MethodSpec>;
  /** Locator members (dot paths for composed components, e.g. header.cartBadge). */
  locators: Record<string, string>;
  /** Locator-returning methods, e.g. notesPage.note(title). */
  locatorMethods?: Record<string, MethodSpec>;
}

export const SORT_OPTIONS = ['az', 'za', 'lohi', 'hilo'] as const;

export const CATALOG: Record<string, FixtureSpec> = {
  loginPage: {
    className: 'LoginPage',
    source: 'src/pages/LoginPage.ts',
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
    source: 'src/pages/InventoryPage.ts',
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
    source: 'src/pages/CartPage.ts',
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
    source: 'src/pages/CheckoutInformationPage.ts',
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
    source: 'src/pages/CheckoutOverviewPage.ts',
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
    source: 'src/pages/CheckoutCompletePage.ts',
    path: '/checkout-complete.html',
    methods: {},
    locators: {
      heading: 'the "Thank you for your order!" heading',
      backHomeButton: 'Back Home button',
    },
  },
};

/**
 * Page objects of the local example notes app (fixtures from
 * src/fixtures/integration.ts). Used by notes UI and combined tests.
 */
export const NOTES_UI_CATALOG: Record<string, FixtureSpec> = {
  notesLoginPage: {
    className: 'NotesLoginPage',
    path: '/login',
    source: 'src/pages/example-app/NotesLoginPage.ts',
    methods: {
      goto: { params: [], description: 'open the sign-in page' },
      signIn: { params: ['string', 'string'], description: 'fill username and password, click "Sign in"' },
    },
    locators: {
      usernameInput: 'username field',
      passwordInput: 'password field',
      signInButton: 'Sign in button',
      errorMessage: 'error alert, e.g. "Invalid username or password"',
    },
  },
  notesPage: {
    className: 'NotesPage',
    path: '/notes',
    source: 'src/pages/example-app/NotesPage.ts',
    methods: {
      goto: { params: [], description: 'open the notes page (signed-out visitors are redirected to /login)' },
      addNote: { params: ['text', 'text'], description: 'fill title and body of the new-note form and submit it' },
      signOut: { params: [], description: 'click "Sign out"' },
    },
    locators: {
      heading: 'page heading "Notes"',
      signedInUser: 'text "Signed in as <username>"',
      titleInput: 'new-note title field',
      bodyInput: 'new-note body field',
      addNoteButton: 'button that submits the new-note form',
      signOutButton: 'Sign out button',
      notes: 'all note entries of the signed-in user',
      errorMessage: 'validation alert, e.g. "title must not be empty"',
    },
    locatorMethods: {
      note: { params: ['text'], description: 'the note entry whose title is exactly the given text' },
    },
  },
};

/** Every page-object fixture the agent knows, across applications. */
export const ALL_PAGE_FIXTURES: Record<string, FixtureSpec> = { ...CATALOG, ...NOTES_UI_CATALOG };

export function splitTarget(target: string): { fixture: string; member: string } | undefined {
  const dot = target.indexOf('.');
  if (dot <= 0) return undefined;
  return { fixture: target.slice(0, dot), member: target.slice(dot + 1) };
}
