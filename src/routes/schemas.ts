import { z } from 'zod';

export const repositoryIdSchema = z.string().regex(/^dir_[A-Za-z0-9_-]{43}$/u);
export const repositoryParamsSchema = z.object({ repositoryId: repositoryIdSchema }).strict();
export const emptyBodySchema = z.object({}).strict();
export const noBodySchema = z.undefined();
