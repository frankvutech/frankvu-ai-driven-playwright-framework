import { test, expect } from '../../src/fixtures/api';
import { parseJson } from '../../src/api/response';
import { PostSchema } from '../../src/api/schemas';

// JSONPlaceholder is a public fake REST API: writes are echoed back but never
// persisted, so these tests assert on the response contract only. It has no
// authentication; auth scenarios live in notes.spec.ts (local example app).

test.describe('Posts API (JSONPlaceholder)', () => {
  test('GET /posts/1 returns the post', async ({ postsApi }) => {
    const response = await postsApi.get(1);

    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/json');
    const post = await parseJson(response, PostSchema);
    expect(post).toMatchObject({ id: 1, userId: 1 });
  });

  test('GET /posts?userId=1 filters by author', async ({ postsApi }) => {
    const response = await postsApi.list({ userId: 1 });

    expect(response.ok()).toBe(true);
    const posts = await parseJson(response, PostSchema.array());
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((p) => p.userId === 1)).toBe(true);
  });

  test('the last post exists and the one after it does not', async ({ postsApi }) => {
    // Boundary: the service seeds exactly 100 posts.
    expect((await postsApi.get(100)).status()).toBe(200);
    expect((await postsApi.get(101)).status()).toBe(404);
  });

  test('GET /posts/0 returns 404', async ({ postsApi }) => {
    const response = await postsApi.get(0);

    expect(response.status()).toBe(404);
  });

  test('POST /posts echoes the created post with an id', async ({ postsApi }) => {
    const payload = { title: 'Phase 1', body: 'POM framework', userId: 7 };

    const response = await postsApi.create(payload);

    expect(response.status()).toBe(201);
    expect(await parseJson(response, PostSchema)).toEqual({ ...payload, id: expect.any(Number) });
  });

  test('PUT /posts/1 replaces the post', async ({ postsApi }) => {
    const replacement = { id: 1, userId: 1, title: 'Replaced title', body: 'Replaced body' };

    const response = await postsApi.replace(1, replacement);

    expect(response.status()).toBe(200);
    expect(await parseJson(response, PostSchema)).toEqual(replacement);
  });

  test('PATCH /posts/1 changes only the given fields', async ({ postsApi }) => {
    const response = await postsApi.update(1, { title: 'Patched title' });

    expect(response.status()).toBe(200);
    const post = await parseJson(response, PostSchema);
    expect(post.title).toBe('Patched title');
    expect(post).toMatchObject({ id: 1, userId: 1 });
  });

  test('DELETE /posts/1 succeeds', async ({ postsApi }) => {
    const response = await postsApi.delete(1);

    expect(response.status()).toBe(200);
  });
});
