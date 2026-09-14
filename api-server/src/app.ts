import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
// JSON-RPC requests are deliberately small: the proxy is read-only and must
// never become a general-purpose transaction relay.
app.use(express.json({ limit: "32kb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Keep malformed/oversize JSON-RPC requests JSON-RPC shaped as well. Without
// this, express's parser would emit an HTML error page before the route runs.
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : 400;
  res.status(status === 413 ? 413 : 400).json({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32600, message: status === 413 ? "Request too large" : "Invalid JSON-RPC request" },
  });
});

export default app;
