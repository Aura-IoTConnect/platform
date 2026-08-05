import { Router } from "express";
import { z } from "zod";

interface Device {
  id: string;
  name: string;
  createdAt: string;
}

const devices: Device[] = [];

const createDeviceSchema = z.object({
  name: z.string().min(1),
});

export const devicesRouter = Router();

devicesRouter.get("/", (_req, res) => {
  res.json(devices);
});

devicesRouter.post("/", (req, res) => {
  const parsed = createDeviceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const device: Device = {
    id: crypto.randomUUID(),
    name: parsed.data.name,
    createdAt: new Date().toISOString(),
  };
  devices.push(device);
  res.status(201).json(device);
});
