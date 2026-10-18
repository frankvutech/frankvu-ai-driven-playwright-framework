import { test, expect } from '@playwright/test';

// JSONPlaceholder is a fake REST API: writes are echoed back but never
// persisted, so these tests assert on the response contract only.

test.describe('Posts API', () => {
  test('GET /posts/1 returns the post', async ({ request }) => {
    const response = await request.get('/posts/1');

    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/json');
    expect(await response.json()).toMatchObject({
      id: 1,
      userId: 1,
      title: expect.any(String),
      body: expect.any(String),
    });
  });

  test('GET /posts?userId=1 filters by author', async ({ request }) => {
    const response = await request.get('/posts', { params: { userId: 1 } });

    expect(response.ok()).toBe(true);
    const posts: Array<{ userId: number }> = await response.json();
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((p) => p.userId === 1)).toBe(true);
  });

  test('GET /posts/0 returns 404', async ({ request }) => {
    const response = await request.get('/posts/0');

    expect(response.status()).toBe(404);
  });

  test('POST /posts echoes the created post with an id', async ({ request }) => {
    const payload = { title: 'Phase 1', body: 'POM framework', userId: 7 };

    const response = await request.post('/posts', { data: payload });

    expect(response.status()).toBe(201);
    expect(await response.json()).toEqual({ ...payload, id: expect.any(Number) });
  });
});
