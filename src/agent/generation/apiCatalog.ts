/**
 * API vocabulary for generated tests: the clients, methods and response
 * schemas that exist in src/api/. A generated API test can only call what is
 * listed here, so it can only reach known endpoints with known contracts.
 * tests/agent/catalog.spec.ts checks this file against the real clients.
 */
export type ApiParam = 'noteId' | 'noteInput' | 'notePatch' | 'postId' | 'postInput' | 'postReplace' | 'postPatch' | 'postQuery' | 'credentials';

export const SCHEMA_NAMES = ['Note', 'NoteList', 'ApiError', 'Token', 'Post', 'PostList'] as const;
export type SchemaName = (typeof SCHEMA_NAMES)[number];

/** Exported zod schema for each name (src/api/schemas.ts). */
export const SCHEMA_EXPORTS: Record<SchemaName, { symbol: string; list: boolean }> = {
  Note: { symbol: 'NoteSchema', list: false },
  NoteList: { symbol: 'NoteSchema', list: true },
  ApiError: { symbol: 'ApiErrorSchema', list: false },
  Token: { symbol: 'TokenSchema', list: false },
  Post: { symbol: 'PostSchema', list: false },
  PostList: { symbol: 'PostSchema', list: true },
};

/**
 * Fields a test may assert on, per schema. "*.x" maps over a list. Secrets
 * (Token.token) are deliberately absent: a test never asserts on a credential.
 */
export const SCHEMA_FIELDS: Record<SchemaName, Record<string, 'string' | 'number' | 'string[]' | 'number[]'>> = {
  Note: { id: 'string', owner: 'string', title: 'string', body: 'string' },
  NoteList: { length: 'number', '*.id': 'string[]', '*.owner': 'string[]', '*.title': 'string[]' },
  ApiError: { 'error.code': 'string', 'error.message': 'string' },
  Token: { tokenType: 'string' },
  Post: { id: 'number', userId: 'number', title: 'string', body: 'string' },
  PostList: { length: 'number', '*.id': 'number[]', '*.userId': 'number[]' },
};

export interface ApiMethodSpec {
  params: ApiParam[];
  /** Schema of a successful response; null when it has no body. */
  returns: SchemaName | null;
  endpoint: string;
  description: string;
}

export interface ApiClientSpec {
  application: 'notes' | 'posts';
  /** Who can call it: example-app users, "anonymous" (no token), or null for unauthenticated APIs. */
  principals: Array<'alice' | 'bob' | 'anonymous' | null>;
  errorSchema: SchemaName | null;
  methods: Record<string, ApiMethodSpec>;
  contract: string[];
}

export const API_CATALOG: Record<'notes' | 'posts' | 'auth', ApiClientSpec> = {
  notes: {
    application: 'notes',
    principals: ['alice', 'bob', 'anonymous'],
    errorSchema: 'ApiError',
    methods: {
      list: { params: [], returns: 'NoteList', endpoint: 'GET /api/notes', description: "the caller's own notes" },
      get: { params: ['noteId'], returns: 'Note', endpoint: 'GET /api/notes/{id}', description: 'one note' },
      create: { params: ['noteInput'], returns: 'Note', endpoint: 'POST /api/notes', description: 'create a note' },
      replace: { params: ['noteId', 'noteInput'], returns: 'Note', endpoint: 'PUT /api/notes/{id}', description: 'replace title and body (omitted body becomes "")' },
      update: { params: ['noteId', 'notePatch'], returns: 'Note', endpoint: 'PATCH /api/notes/{id}', description: 'change only the given fields' },
      delete: { params: ['noteId'], returns: null, endpoint: 'DELETE /api/notes/{id}', description: 'delete a note (204, empty body)' },
    },
    contract: [
      'All /api/notes calls need "Authorization: Bearer <token>"; without a valid token: 401, header www-authenticate "Bearer", error.code "unauthorized".',
      'A note owned by another user: 403, error.code "forbidden" (get, replace, update, delete). Unknown id: 404, error.code "not_found".',
      'create: 201, header location "/api/notes/{id}", body Note with owner = caller. get/replace/update: 200 Note. delete: 204.',
      'title: trimmed length 1..120, else 400 error.code "validation_error". body: at most 1000 characters. Unknown fields: 400.',
      'Successful JSON responses carry header cache-control "no-store".',
    ],
  },
  auth: {
    application: 'notes',
    principals: [null],
    errorSchema: 'ApiError',
    methods: {
      token: { params: ['credentials'], returns: 'Token', endpoint: 'POST /api/auth/token', description: 'exchange username and password for a bearer token' },
    },
    contract: ['Valid credentials: 200 Token with tokenType "Bearer". Wrong password: 401 error.code "invalid_credentials".'],
  },
  posts: {
    application: 'posts',
    principals: [null],
    errorSchema: null,
    methods: {
      list: { params: ['postQuery'], returns: 'PostList', endpoint: 'GET /posts?userId=', description: 'posts, optionally filtered by userId' },
      get: { params: ['postId'], returns: 'Post', endpoint: 'GET /posts/{id}', description: 'one post (ids 1..100 exist)' },
      create: { params: ['postInput'], returns: 'Post', endpoint: 'POST /posts', description: 'echoes the post with a new id (201), not persisted' },
      replace: { params: ['postId', 'postReplace'], returns: 'Post', endpoint: 'PUT /posts/{id}', description: 'echoes the replacement (200)' },
      update: { params: ['postId', 'postPatch'], returns: 'Post', endpoint: 'PATCH /posts/{id}', description: 'echoes the merged post (200)' },
      delete: { params: ['postId'], returns: null, endpoint: 'DELETE /posts/{id}', description: 'returns 200' },
    },
    contract: ['Posts 1..100 exist; 0 and 101 return 404 with an empty JSON object. No authentication.'],
  },
};

export type ApiClientName = keyof typeof API_CATALOG;
