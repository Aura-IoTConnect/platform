import type { ErrorRequestHandler } from "express";
import { Prisma } from "@prisma/client";

// Prisma raises P2025 when an update/delete targets a row that doesn't
// exist. Routes use this to turn exactly that case into a 404 and let every
// other failure (DB down, constraint violation, bug) fall through to the
// global error handler instead of being misreported as "not found".
export function isRecordNotFound(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025";
}

// Registered last in app.ts. Express 4 doesn't catch async route rejections
// on its own — `express-async-errors` (imported in app.ts) forwards them
// here. Logs the real error server-side and returns a generic body so
// internals never leak to the client.
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  // express.json() rejects malformed bodies with a SyntaxError tagged
  // entity.parse.failed — that's the client's mistake, not a server fault.
  if (err && typeof err === "object" && (err as { type?: string }).type === "entity.parse.failed") {
    res.status(400).json({ error: "Malformed JSON body" });
    return;
  }
  console.error(`unhandled error on ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: "Internal server error" });
};
