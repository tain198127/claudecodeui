import express, { type Request, type Response } from 'express';

import { upstreamsService } from '@/modules/upstreams/service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

const router = express.Router();

const readPathParam = (value: unknown, name: string): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }

  throw new AppError(`${name} path parameter is invalid.`, {
    code: 'INVALID_PATH_PARAMETER',
    statusCode: 400,
  });
};

const parseUpstreamId = (value: unknown): string => readPathParam(value, 'id').trim();

/**
 * Reads the create/update payload from the body without validating it.
 *
 * Shape and range rules live in the service so a malformed field produces the
 * same error whichever route received it. A non-object body reads as an empty
 * one, which the service then rejects field by field.
 */
const parseUpstreamPayload = (body: unknown): Record<string, unknown> => (
  body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {}
);

// ----------------- Upstream routes -----------------
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(createApiSuccessResponse({ upstreams: upstreamsService.list() }));
  }),
);

router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const upstream = upstreamsService.create(parseUpstreamPayload(req.body));
    res.status(201).json(createApiSuccessResponse({ upstream }));
  }),
);

router.patch(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const upstream = upstreamsService.update(parseUpstreamId(req.params.id), parseUpstreamPayload(req.body));
    res.json(createApiSuccessResponse({ upstream }));
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const upstream = upstreamsService.remove(parseUpstreamId(req.params.id));
    res.json(createApiSuccessResponse({ upstream }));
  }),
);

router.post(
  '/:id/default',
  asyncHandler(async (req: Request, res: Response) => {
    const upstream = upstreamsService.setDefault(parseUpstreamId(req.params.id));
    res.json(createApiSuccessResponse({ upstream }));
  }),
);

router.post(
  '/:id/test',
  asyncHandler(async (req: Request, res: Response) => {
    const result = await upstreamsService.testConnection(parseUpstreamId(req.params.id));
    res.json(createApiSuccessResponse(result));
  }),
);

export default router;
