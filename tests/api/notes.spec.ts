import { test, expect } from '../../src/fixtures/api';
import { requestToken } from '../../src/api/NotesClient';
import { parseJson } from '../../src/api/response';
import { ApiErrorSchema, NoteSchema, TokenSchema } from '../../src/api/schemas';
import { exampleAppUsers } from '../../src/data/exampleApp';
import { buildNote } from '../../src/data/notes';

// Local example app (example-app/), started per worker by the exampleAppUrl
// fixture. It covers what the public API cannot: auth, 401/403 and real state.

test.describe('Notes API: authentication', () => {
  test('issues a bearer token for valid credentials', async ({ exampleAppApi }) => {
    const response = await requestToken(await exampleAppApi.anonymous(), exampleAppUsers.alice);

    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toBe('no-store');
    expect(await parseJson(response, TokenSchema)).toEqual({ token: expect.any(String), tokenType: 'Bearer' });
  });

  test('rejects a wrong password with 401', async ({ exampleAppApi }) => {
    const response = await requestToken(await exampleAppApi.anonymous(), { username: 'alice', password: 'wrong-password' });

    expect(response.status()).toBe(401);
    expect((await parseJson(response, ApiErrorSchema)).error.code).toBe('invalid_credentials');
  });

  test('rejects a token request without a password with 400', async ({ exampleAppApi }) => {
    const anonymous = await exampleAppApi.anonymous();

    const response = await anonymous.post('/api/auth/token', { data: { username: 'alice' } });

    expect(response.status()).toBe(400);
    expect((await parseJson(response, ApiErrorSchema)).error.code).toBe('validation_error');
  });

  test('requires a token for notes (401 with WWW-Authenticate)', async ({ exampleAppApi }) => {
    const response = await (await exampleAppApi.anonymous()).get('/api/notes');

    expect(response.status()).toBe(401);
    expect(response.headers()['www-authenticate']).toBe('Bearer');
    expect((await parseJson(response, ApiErrorSchema)).error.code).toBe('unauthorized');
  });

  test('rejects an unknown token with 401', async ({ exampleAppApi }) => {
    const anonymous = await exampleAppApi.anonymous();

    const response = await anonymous.get('/api/notes', { headers: { Authorization: 'Bearer not-a-real-token' } });

    expect(response.status()).toBe(401);
  });
});

test.describe('Notes API: CRUD', () => {
  test('creates a note (201, Location header, schema)', async ({ exampleAppApi, testPrefix }) => {
    const alice = await exampleAppApi.as('alice');
    const input = buildNote(testPrefix);

    const response = await alice.create(input);

    expect(response.status()).toBe(201);
    const note = await parseJson(response, NoteSchema);
    expect(response.headers()['location']).toBe(`/api/notes/${note.id}`);
    expect(note).toMatchObject({ ...input, owner: 'alice' });
    expect(note.createdAt).toBe(note.updatedAt);
  });

  test('reads a note by id and lists it', async ({ exampleAppApi, testPrefix }) => {
    const alice = await exampleAppApi.as('alice');
    const created = await parseJson(await alice.create(buildNote(testPrefix)), NoteSchema);

    const read = await alice.get(created.id);
    const list = await alice.list();

    expect(read.status()).toBe(200);
    expect(await parseJson(read, NoteSchema)).toEqual(created);
    expect(list.status()).toBe(200);
    expect(await parseJson(list, NoteSchema.array())).toContainEqual(created);
  });

  test('PUT replaces the whole note', async ({ exampleAppApi, testPrefix }) => {
    const alice = await exampleAppApi.as('alice');
    const created = await parseJson(await alice.create(buildNote(testPrefix)), NoteSchema);

    const response = await alice.replace(created.id, { title: `${testPrefix} Replaced` });

    expect(response.status()).toBe(200);
    // PUT without a body clears it.
    expect(await parseJson(response, NoteSchema)).toMatchObject({ id: created.id, title: `${testPrefix} Replaced`, body: '' });
  });

  test('PATCH changes only the given fields', async ({ exampleAppApi, testPrefix }) => {
    const alice = await exampleAppApi.as('alice');
    const created = await parseJson(await alice.create(buildNote(testPrefix)), NoteSchema);

    const response = await alice.update(created.id, { body: 'Only the body changed' });

    expect(response.status()).toBe(200);
    expect(await parseJson(response, NoteSchema)).toMatchObject({ title: created.title, body: 'Only the body changed' });
  });

  test('DELETE removes the note', async ({ exampleAppApi, testPrefix }) => {
    const alice = await exampleAppApi.as('alice');
    const created = await parseJson(await alice.create(buildNote(testPrefix)), NoteSchema);

    const response = await alice.delete(created.id);

    expect(response.status()).toBe(204);
    expect(await response.text()).toBe('');
    expect((await alice.get(created.id)).status()).toBe(404);
  });

  test('unknown note id returns 404', async ({ exampleAppApi }) => {
    const alice = await exampleAppApi.as('alice');

    const response = await alice.get('00000000-0000-4000-8000-000000000000');

    expect(response.status()).toBe(404);
    expect((await parseJson(response, ApiErrorSchema)).error.code).toBe('not_found');
  });

  test('unsupported method returns 405 with Allow', async ({ exampleAppApi }) => {
    const alice = await exampleAppApi.as('alice');

    const response = await alice.request.put('/api/notes', { data: {} });

    expect(response.status()).toBe(405);
    expect(response.headers()['allow']).toBe('GET, POST');
  });
});

test.describe('Notes API: validation and boundaries', () => {
  test('accepts titles of 1 and 120 characters', async ({ exampleAppApi, testPrefix }) => {
    const alice = await exampleAppApi.as('alice');
    // The prefix keeps the notes cleanable; it is padded to exactly 120 characters.
    const longest = `${testPrefix} `.padEnd(120, 'x');

    const longResponse = await alice.create({ title: longest });
    const shortResponse = await alice.create({ title: 'x' });

    expect(longResponse.status()).toBe(201);
    expect((await parseJson(longResponse, NoteSchema)).title).toHaveLength(120);
    expect(shortResponse.status()).toBe(201);
    // A one-character title cannot carry the cleanup prefix: delete it here.
    const short = await parseJson(shortResponse, NoteSchema);
    expect((await alice.delete(short.id)).status()).toBe(204);
  });

  for (const [name, title] of [
    ['empty', ''],
    ['whitespace-only', '   '],
    ['121-character', 'x'.repeat(121)],
  ] as const) {
    test(`rejects an ${name} title with 400`, async ({ exampleAppApi }) => {
      const alice = await exampleAppApi.as('alice');

      const response = await alice.create({ title });

      expect(response.status()).toBe(400);
      expect((await parseJson(response, ApiErrorSchema)).error.code).toBe('validation_error');
    });
  }

  test('rejects unknown fields with 400', async ({ exampleAppApi, testPrefix }) => {
    const alice = await exampleAppApi.as('alice');

    const response = await alice.request.post('/api/notes', { data: { ...buildNote(testPrefix), owner: 'bob' } });

    expect(response.status()).toBe(400);
    expect((await parseJson(response, ApiErrorSchema)).error.message).toContain('owner');
  });

  test('rejects malformed JSON with 400 and a non-JSON body with 415', async ({ exampleAppApi }) => {
    const alice = await exampleAppApi.as('alice');

    // A Buffer is sent as-is; a string `data` would be JSON-encoded by Playwright.
    const malformed = await alice.request.post('/api/notes', {
      data: Buffer.from('{"title": '),
      headers: { 'Content-Type': 'application/json' },
    });
    const form = await alice.request.post('/api/notes', { form: { title: 'x' } });

    expect(malformed.status()).toBe(400);
    expect((await parseJson(malformed, ApiErrorSchema)).error.code).toBe('invalid_json');
    expect(form.status()).toBe(415);
  });
});

test.describe('Notes API: authorization', () => {
  test("another user's note is forbidden (403) for read, update and delete", async ({ exampleAppApi, testPrefix }) => {
    const alice = await exampleAppApi.as('alice');
    const bob = await exampleAppApi.as('bob');
    const note = await parseJson(await alice.create(buildNote(testPrefix)), NoteSchema);

    const responses = [await bob.get(note.id), await bob.update(note.id, { title: 'hijacked' }), await bob.delete(note.id)];

    expect(responses.map((r) => r.status())).toEqual([403, 403, 403]);
    expect((await parseJson(responses[0], ApiErrorSchema)).error.code).toBe('forbidden');
    // The note is unchanged.
    expect(await parseJson(await alice.get(note.id), NoteSchema)).toEqual(note);
  });

  test("a user's list does not include other users' notes", async ({ exampleAppApi, testPrefix }) => {
    const alice = await exampleAppApi.as('alice');
    const bob = await exampleAppApi.as('bob');
    const bobsNote = await parseJson(await bob.create(buildNote(testPrefix, { title: `${testPrefix} Bob only` })), NoteSchema);

    const aliceNotes = await parseJson(await alice.list(), NoteSchema.array());

    expect(aliceNotes.map((n) => n.id)).not.toContain(bobsNote.id);
    expect(aliceNotes.every((n) => n.owner === 'alice')).toBe(true);
  });
});
