import { Router } from "express";
import { z } from "zod";
import { signToken, verifyPassword } from "../auth.js";
import { prisma } from "../db.js";
import { createLoginLimiterFromEnv } from "../loginLimiter.js";

const loginLimiter = createLoginLimiterFromEnv();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const authRouter = Router();

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  // Brute-force guard: only failed attempts count (see ../loginLimiter.ts).
  const clientKey = req.ip ?? "unknown";
  const retryAfter = loginLimiter.retryAfterSeconds(clientKey);
  if (retryAfter > 0) {
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ error: "Too many failed login attempts — try again later" });
    return;
  }

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
    loginLimiter.recordFailure(clientKey);
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  loginLimiter.reset(clientKey);

  const token = signToken({ id: user.id, email: user.email, role: user.role });
  res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
});
