import type { APIRequestContext, APIResponse } from '@playwright/test';
import type { PostInput } from './schemas';

/**
 * JSONPlaceholder /posts. Methods return the raw APIResponse so tests can
 * assert status, headers and body themselves; parse bodies with parseJson().
 * Writes are echoed by the service but never persisted.
 */
export class PostsClient {
  constructor(private readonly request: APIRequestContext) {}

  list(query: { userId?: number } = {}): Promise<APIResponse> {
    return this.request.get('/posts', { params: query });
  }

  get(id: number): Promise<APIResponse> {
    return this.request.get(`/posts/${id}`);
  }

  create(post: PostInput): Promise<APIResponse> {
    return this.request.post('/posts', { data: post });
  }

  replace(id: number, post: PostInput & { id: number }): Promise<APIResponse> {
    return this.request.put(`/posts/${id}`, { data: post });
  }

  update(id: number, changes: Partial<PostInput>): Promise<APIResponse> {
    return this.request.patch(`/posts/${id}`, { data: changes });
  }

  delete(id: number): Promise<APIResponse> {
    return this.request.delete(`/posts/${id}`);
  }
}
