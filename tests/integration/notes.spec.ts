import { test, expect } from '../../src/fixtures/integration';
import { parseJson } from '../../src/api/response';
import { NoteSchema } from '../../src/api/schemas';
import { exampleAppUsers } from '../../src/data/exampleApp';
import { buildNote } from '../../src/data/notes';

// UI + API workflows against one instance of the local example app.

test.describe('Notes: UI and API together', () => {
  test('a note created through the API is shown in the UI', async ({ exampleAppApi, signInBrowser, notesPage, testPrefix }) => {
    const alice = await exampleAppApi.as('alice');
    const input = buildNote(testPrefix);
    expect((await alice.create(input)).status()).toBe(201);

    await signInBrowser('alice');
    await notesPage.goto();

    await expect(notesPage.note(input.title)).toBeVisible();
    await expect(notesPage.note(input.title).getByTestId('note-body')).toHaveText(input.body!);
  });

  test('a note added in the UI is returned by the API', async ({ exampleAppApi, signInBrowser, notesPage, testPrefix }) => {
    const input = buildNote(testPrefix, { title: `${testPrefix} Added in the UI` });
    await signInBrowser('alice');
    await notesPage.goto();

    await notesPage.addNote(input.title, input.body);

    await expect(notesPage.note(input.title)).toBeVisible();
    const notes = await parseJson(await (await exampleAppApi.as('alice')).list(), NoteSchema.array());
    expect(notes.filter((n) => n.title === input.title)).toEqual([expect.objectContaining({ ...input, owner: 'alice' })]);
  });

  test('an empty title is rejected in the UI and nothing is stored', async ({ exampleAppApi, signInBrowser, notesPage, testPrefix }) => {
    await signInBrowser('alice');
    await notesPage.goto();

    await notesPage.addNote('   ', `${testPrefix} body without a title`);

    await expect(notesPage.errorMessage).toHaveText('title must not be empty');
    const notes = await parseJson(await (await exampleAppApi.as('alice')).list(), NoteSchema.array());
    expect(notes.filter((n) => n.body.startsWith(testPrefix))).toEqual([]);
  });

  test("another user's notes are not shown", async ({ exampleAppApi, signInBrowser, notesPage, testPrefix }) => {
    const bob = await exampleAppApi.as('bob');
    const bobsTitle = `${testPrefix} Bob's private note`;
    expect((await bob.create({ title: bobsTitle })).status()).toBe(201);

    await signInBrowser('alice');
    await notesPage.goto();

    await expect(notesPage.signedInUser).toHaveText('Signed in as alice');
    await expect(notesPage.note(bobsTitle)).toHaveCount(0);
  });
});

test.describe('Notes: sign-in UI', () => {
  test('signs in with the form and signs out', async ({ page, notesLoginPage, notesPage }) => {
    await notesLoginPage.goto();

    await notesLoginPage.signIn(exampleAppUsers.alice.username, exampleAppUsers.alice.password);

    await expect(page).toHaveURL(/\/notes$/);
    await expect(notesPage.signedInUser).toHaveText('Signed in as alice');

    await notesPage.signOut();

    await expect(page).toHaveURL(/\/login$/);
  });

  test('a wrong password shows an error', async ({ page, notesLoginPage }) => {
    await notesLoginPage.goto();

    await notesLoginPage.signIn('alice', 'wrong-password');

    await expect(notesLoginPage.errorMessage).toHaveText('Invalid username or password');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('a signed-out visitor is sent to the sign-in page', async ({ page }) => {
    await page.goto('/notes');

    await expect(page).toHaveURL(/\/login$/);
  });
});
