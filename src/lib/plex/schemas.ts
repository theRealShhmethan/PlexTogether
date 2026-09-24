import { z } from "zod";

/**
 * Schemas for the parts of Plex responses we rely on. Unknown fields are
 * stripped, so nothing we don't expect is carried around by accident.
 */

export const PinSchema = z.object({
  id: z.number().int(),
  code: z.string().min(1),
  expiresAt: z.string().optional(),
  // null until the user has signed in on app.plex.tv.
  authToken: z.string().nullable().optional(),
});
export type Pin = z.infer<typeof PinSchema>;

export const NonceSchema = z.object({ nonce: z.string().min(1) });

export const TokenExchangeSchema = z.object({ auth_token: z.string().min(1) });

export const PlexUserSchema = z.object({
  id: z.number().int(),
  uuid: z.string().optional(),
  username: z.string().optional(),
  title: z.string().optional(),
  friendlyName: z.string().optional(),
  thumb: z.string().optional(),
  subscription: z
    .object({
      active: z.boolean().optional(),
      plan: z.string().nullable().optional(),
    })
    .optional(),
});
export type PlexUser = z.infer<typeof PlexUserSchema>;
