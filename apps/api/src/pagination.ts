import type { Request } from "express";

// `limit`/`offset` for list endpoints that previously returned every row.
// Responses stay a plain array (the dashboard depends on that); the total is
// reported separately in an `X-Total-Count` header so a client can tell when
// it's looking at a truncated page.
export function paginationFrom(
  req: Request,
  { defaultLimit, maxLimit }: { defaultLimit: number; maxLimit: number },
): { take: number; skip: number } {
  const limit = Math.floor(Number(req.query.limit));
  const offset = Math.floor(Number(req.query.offset));
  return {
    take: Number.isFinite(limit) && limit > 0 ? Math.min(limit, maxLimit) : defaultLimit,
    skip: Number.isFinite(offset) && offset > 0 ? offset : 0,
  };
}
