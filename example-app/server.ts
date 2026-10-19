import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Local EXAMPLE application. It is not a product and is not deployed
 * anywhere. It exists only so the framework can verify what the public demo
 * targets cannot offer: bearer-token auth (401/403), real CRUD with state,
 * and UI + API workflows against one application.
 *
 * - REST API under /api (JSON, `Authorization: Bearer <token>`)
 * - Server-rendered notes UI (cookie session), no client-side JavaScript
 * - In-memory state per process; users are passed in by the caller
 */
export interface ExampleAppUser {
  username: string;
  password: string;
}

export interface Note {
  id: string;
  owner: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunningExampleApp {
  url: string;
  close(): Promise<void>;
}

export const TITLE_MAX = 120;
export const BODY_MAX = 1000;
const MAX_REQUEST_BYTES = 16 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function startExampleApp(options: { users: ExampleAppUser[]; port?: number; host?: string }): Promise<RunningExampleApp> {
  const users = new Map(options.users.map((u) => [u.username, u.password]));
  const tokens = new Map<string, string>(); // token -> username
  const notes = new Map<string, Note>();

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) return sendError(res, error);
      sendError(res, new HttpError(500, 'internal_error', 'Unexpected server error'));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    const parts = url.pathname.split('/').filter(Boolean);

    if (parts[0] === 'api') return handleApi(req, res, method, parts.slice(1));

    // ---- UI (cookie session) ----
    if (url.pathname === '/' && method === 'GET') return redirect(res, '/notes');
    if (url.pathname === '/login' && method === 'GET') return sendHtml(res, 200, loginPage());
    if (url.pathname === '/login' && method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      const token = signIn(form.get('username') ?? '', form.get('password') ?? '');
      if (!token) return sendHtml(res, 401, loginPage('Invalid username or password'));
      res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Lax; Path=/`);
      return redirect(res, '/notes');
    }
    if (url.pathname === '/logout' && method === 'POST') {
      const token = cookieToken(req);
      if (token) tokens.delete(token);
      res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      return redirect(res, '/login');
    }
    if (url.pathname === '/notes') {
      const user = userFor(cookieToken(req));
      if (!user) return redirect(res, '/login');
      if (method === 'GET') return sendHtml(res, 200, notesPage(user, ownedBy(user)));
      if (method === 'POST') {
        const form = new URLSearchParams(await readBody(req));
        const problem = validationProblem({ title: form.get('title') ?? '', body: form.get('body') ?? '' });
        if (problem) return sendHtml(res, 400, notesPage(user, ownedBy(user), problem));
        createNote(user, { title: form.get('title') ?? '', body: form.get('body') ?? '' });
        return redirect(res, '/notes');
      }
    }
    throw new HttpError(404, 'not_found', 'Not found');
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, method: string, parts: string[]): Promise<void> {
    if (parts[0] === 'health' && parts.length === 1 && method === 'GET') return sendJson(res, 200, { status: 'ok' });

    if (parts[0] === 'auth' && parts[1] === 'token' && parts.length === 2) {
      if (method !== 'POST') throw methodNotAllowed(res, ['POST']);
      const body = await readJson(req);
      const username = typeof body.username === 'string' ? body.username : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (!username || !password) throw new HttpError(400, 'validation_error', 'username and password are required');
      const token = signIn(username, password);
      if (!token) throw new HttpError(401, 'invalid_credentials', 'Invalid username or password');
      return sendJson(res, 200, { token, tokenType: 'Bearer' });
    }

    if (parts[0] !== 'notes' || parts.length > 2) throw new HttpError(404, 'not_found', 'Not found');
    const user = bearerUser(req);

    if (parts.length === 1) {
      if (method === 'GET') return sendJson(res, 200, ownedBy(user));
      if (method === 'POST') {
        const input = noteInput(await readJson(req), 'create');
        const note = createNote(user, { title: input.title ?? '', body: input.body ?? '' });
        res.setHeader('Location', `/api/notes/${note.id}`);
        return sendJson(res, 201, note);
      }
      throw methodNotAllowed(res, ['GET', 'POST']);
    }

    const note = notes.get(parts[1]);
    if (!note) throw new HttpError(404, 'not_found', 'Note not found');
    if (note.owner !== user) throw new HttpError(403, 'forbidden', 'You do not have access to this note');

    switch (method) {
      case 'GET':
        return sendJson(res, 200, note);
      case 'PUT':
      case 'PATCH': {
        const input = noteInput(await readJson(req), method === 'PUT' ? 'replace' : 'update');
        const updated: Note = {
          ...note,
          title: input.title ?? note.title,
          body: method === 'PUT' ? (input.body ?? '') : (input.body ?? note.body),
          updatedAt: new Date().toISOString(),
        };
        notes.set(note.id, updated);
        return sendJson(res, 200, updated);
      }
      case 'DELETE':
        notes.delete(note.id);
        res.writeHead(204).end();
        return;
      default:
        throw methodNotAllowed(res, ['GET', 'PUT', 'PATCH', 'DELETE']);
    }
  }

  function signIn(username: string, password: string): string | undefined {
    const expected = users.get(username);
    if (expected === undefined || !sameSecret(expected, password)) return undefined;
    const token = randomBytes(24).toString('base64url');
    tokens.set(token, username);
    return token;
  }

  function userFor(token: string | undefined): string | undefined {
    return token ? tokens.get(token) : undefined;
  }

  function bearerUser(req: IncomingMessage): string {
    const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? '');
    const user = userFor(match?.[1]);
    if (!user) throw new HttpError(401, 'unauthorized', 'A valid bearer token is required');
    return user;
  }

  function ownedBy(user: string): Note[] {
    return [...notes.values()].filter((n) => n.owner === user);
  }

  function createNote(owner: string, input: { title: string; body: string }): Note {
    const now = new Date().toISOString();
    const note: Note = { id: randomUUID(), owner, title: input.title.trim(), body: input.body, createdAt: now, updatedAt: now };
    notes.set(note.id, note);
    return note;
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

// ---- validation ----

function noteInput(body: Record<string, unknown>, mode: 'create' | 'replace' | 'update'): { title?: string; body?: string } {
  const unknown = Object.keys(body).filter((k) => k !== 'title' && k !== 'body');
  if (unknown.length > 0) throw new HttpError(400, 'validation_error', `Unknown field(s): ${unknown.join(', ')}`);
  if (body.title !== undefined && typeof body.title !== 'string') throw new HttpError(400, 'validation_error', 'title must be a string');
  if (body.body !== undefined && typeof body.body !== 'string') throw new HttpError(400, 'validation_error', 'body must be a string');
  if (mode !== 'update' && body.title === undefined) throw new HttpError(400, 'validation_error', 'title is required');
  if (mode === 'update' && body.title === undefined && body.body === undefined) {
    throw new HttpError(400, 'validation_error', 'Provide title or body');
  }
  const problem = validationProblem({ title: body.title as string | undefined, body: body.body as string | undefined });
  if (problem) throw new HttpError(400, 'validation_error', problem);
  return { title: body.title === undefined ? undefined : (body.title as string).trim(), body: body.body as string | undefined };
}

function validationProblem(input: { title?: string; body?: string }): string | undefined {
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (title.length === 0) return 'title must not be empty';
    if (title.length > TITLE_MAX) return `title must be at most ${TITLE_MAX} characters`;
  }
  if (input.body !== undefined && input.body.length > BODY_MAX) return `body must be at most ${BODY_MAX} characters`;
  return undefined;
}

// ---- HTTP helpers ----

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_REQUEST_BYTES) throw new HttpError(413, 'payload_too_large', 'Request body is too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'validation_error', 'Request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function cookieToken(req: IncomingMessage): string | undefined {
  return /(?:^|;\s*)session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1];
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function methodNotAllowed(res: ServerResponse, allowed: string[]): HttpError {
  res.setHeader('Allow', allowed.join(', '));
  return new HttpError(405, 'method_not_allowed', 'Method not allowed');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, error: HttpError): void {
  if (res.headersSent) return void res.end();
  if (error.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
  sendJson(res, error.status, { error: { code: error.code, message: error.message } });
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { Location: location }).end();
}

// ---- views ----

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function layout(title: string, content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)} · Example Notes</title></head><body><main>${content}</main></body></html>`;
}

function loginPage(error?: string): string {
  return layout(
    'Sign in',
    `<h1>Sign in</h1>
${error ? `<p role="alert" data-test="login-error">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/login">
  <label>Username <input name="username" autocomplete="username" required></label>
  <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
  <button type="submit">Sign in</button>
</form>`,
  );
}

function notesPage(user: string, items: Note[], error?: string): string {
  const list = items
    .map((n) => `<li data-test="note"><h2 data-test="note-title">${escapeHtml(n.title)}</h2><p data-test="note-body">${escapeHtml(n.body)}</p></li>`)
    .join('');
  return layout(
    'Notes',
    `<header><p data-test="signed-in-user">Signed in as ${escapeHtml(user)}</p>
<form method="post" action="/logout"><button type="submit">Sign out</button></form></header>
<h1>Notes</h1>
${error ? `<p role="alert" data-test="note-error">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/notes" aria-label="New note">
  <label>Title <input name="title"></label>
  <label>Body <textarea name="body"></textarea></label>
  <button type="submit">Add note</button>
</form>
${items.length === 0 ? '<p data-test="empty-state">No notes yet</p>' : `<ul data-test="note-list">${list}</ul>`}`,
  );
}
