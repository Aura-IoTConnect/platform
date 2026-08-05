import cors from "cors";
import express from "express";
import { devicesRouter } from "./routes/devices.js";

const app = express();
const port = process.env.PORT ?? 4000;

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/devices", devicesRouter);

app.listen(port, () => {
  console.log(`api listening on port ${port}`);
});
