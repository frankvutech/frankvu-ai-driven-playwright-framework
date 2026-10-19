import type { Locator, Page } from '@playwright/test';

/** Notes list and "new note" form of the local example app (example-app/). */
export class NotesPage {
  readonly heading: Locator;
  readonly signedInUser: Locator;
  readonly titleInput: Locator;
  readonly bodyInput: Locator;
  readonly addNoteButton: Locator;
  readonly signOutButton: Locator;
  readonly notes: Locator;
  readonly errorMessage: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole('heading', { level: 1 });
    this.signedInUser = page.getByTestId('signed-in-user');
    const form = page.getByRole('form', { name: 'New note' });
    this.titleInput = form.getByLabel('Title');
    this.bodyInput = form.getByLabel('Body');
    this.addNoteButton = form.getByRole('button', { name: 'Add note' });
    this.signOutButton = page.getByRole('button', { name: 'Sign out' });
    this.notes = page.getByTestId('note');
    this.errorMessage = page.getByRole('alert');
  }

  async goto(): Promise<void> {
    await this.page.goto('/notes');
  }

  /** The list entry whose title is exactly `title`. */
  note(title: string): Locator {
    return this.notes.filter({ has: this.page.getByTestId('note-title').getByText(title, { exact: true }) });
  }

  /** All list entries whose title starts with `prefix` (a test's own notes). */
  notesStartingWith(prefix: string): Locator {
    return this.notes.filter({ has: this.page.getByTestId('note-title').getByText(prefix) });
  }

  async addNote(title: string, body = ''): Promise<void> {
    await this.titleInput.fill(title);
    await this.bodyInput.fill(body);
    await this.addNoteButton.click();
  }

  async signOut(): Promise<void> {
    await this.signOutButton.click();
  }
}
