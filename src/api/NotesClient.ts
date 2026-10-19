import type { APIRequestContext, APIResponse } from '@playwright/test';
import type { NoteInput } from './schemas';

/**
 * Example app /api/notes. Authentication is a property of the request
 * context it is given (see the exampleAppApi fixture), not of the client.
 * `request` stays public so negative tests can send malformed requests.
 */
export class NotesClient {
  constructor(readonly request: APIRequestContext) {}

  list(): Promise<APIResponse> {
    return this.request.get('/api/notes');
  }

  get(id: string): Promise<APIResponse> {
    return this.request.get(`/api/notes/${id}`);
  }

  create(note: NoteInput): Promise<APIResponse> {
    return this.request.post('/api/notes', { data: note });
  }

  replace(id: string, note: NoteInput): Promise<APIResponse> {
    return this.request.put(`/api/notes/${id}`, { data: note });
  }

  update(id: string, changes: Partial<NoteInput>): Promise<APIResponse> {
    return this.request.patch(`/api/notes/${id}`, { data: changes });
  }

  delete(id: string): Promise<APIResponse> {
    return this.request.delete(`/api/notes/${id}`);
  }
}

/** POST /api/auth/token. Used by fixtures; tests call it directly for auth scenarios. */
export function requestToken(request: APIRequestContext, credentials: { username: string; password: string }): Promise<APIResponse> {
  return request.post('/api/auth/token', { data: credentials });
}
