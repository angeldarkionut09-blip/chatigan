import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./db.js";
import { errorHandler, originGuard, csrfGuard } from "./http.js";
import { attachSession } from "./session.js";
import { isConfiguredThrottleSecret } from "./security.js";
import authRoutes from "./routes/auth.js";
import adminRoutes from "./routes/admin.js";
import reportRoutes from "./routes/reports.js";
import publicRoutes from "./routes/public.js";
import chatRoutes from "./routes/chat.js";

const currentDirectory = fileURLToPath(new URL(".", import.meta.url));
const app = express();
const port = Number(process.env.PORT ?? 3000);
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);

if (process.env.NODE_ENV === "production" && (!process.env.APP_ORIGIN || !isConfiguredThrottleSecret(process.env.LOGIN_THROTTLE_SECRET))) {
  throw new Error("APP_ORIGIN și un LOGIN_THROTTLE_SECRET de minimum 32 caractere sunt obligatorii în producție.");
}

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      ...(process.env.NODE_ENV === "production" ? { upgradeInsecureRequests: [] } : {}),
    },
  },
  referrerPolicy: { policy: "no-referrer" },
}));
app.use(express.json({ limit: "32kb", strict: true }));
app.use(cookieParser());
app.use(originGuard);
app.use(attachSession);
app.use(csrfGuard);

app.get("/api/health", async (_req, res) => {
  try {
    await db.$queryRaw`SELECT 1`;
    res.json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "unavailable" });
  }
});
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/chat", chatRoutes);

if (process.env.NODE_ENV === "production") {
  const clientDirectory = resolve(currentDirectory, "../client");
  app.use(express.static(clientDirectory, { index: false, maxAge: "1h" }));
  app.get("*splat", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(resolve(clientDirectory, "index.html"));
  });
}

app.use(errorHandler);

await db.$connect();
app.listen(port, "0.0.0.0", () => {
  console.log(`ChaTiganu API listening on port ${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void db.$disconnect().finally(() => process.exit(0));
  });
}
