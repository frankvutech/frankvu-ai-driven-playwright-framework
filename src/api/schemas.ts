import { z } from 'zod';

/**
 * Response contracts, checked with parseJson() in tests. Objects are strict
 * where the API is ours (example app) and loose where it is a third party
 * (JSONPlaceholder), so an extra upstream field does not fail the suite.
 */

// ---- JSONPlaceholder (public example API) ----
export const PostSchema = z.object({
  id: z.number().int().positive(),
  userId: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
});
export type Post = z.infer<typeof PostSchema>;
export type PostInput = Omit<Post, 'id'>;

// ---- Local example app (example-app/) ----
export const TokenSchema = z.object({ token: z.string().min(20), tokenType: z.literal('Bearer') }).strict();

export const NoteSchema = z
  .object({
    id: z.uuid(),
    owner: z.string(),
    title: z.string().min(1).max(120),
    body: z.string().max(1000),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type Note = z.infer<typeof NoteSchema>;
export type NoteInput = { title: string; body?: string };

export const ApiErrorSchema = z
  .object({ error: z.object({ code: z.string(), message: z.string() }).strict() })
  .strict();
