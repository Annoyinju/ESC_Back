import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { authRoutes } from "./routes/authRoutes";
import { drawingRoutes } from "./routes/drawingRoutes";
import { exploreRoutes } from "./routes/drawingRoutes";

const app = new Hono();

app.use("/api/*", cors({ origin: process.env.FRONTEND_URL!, credentials: true }));

app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api/auth", authRoutes);
app.route("/api/drawings", drawingRoutes);
app.route("/api/explore", exploreRoutes);

app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "Server error" }, 500);
});

serve({ fetch: app.fetch, port: 3000 }, () => console.log("API on http://localhost:3000"));