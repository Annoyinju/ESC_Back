import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { csrf } from "hono/csrf"
import { authRoutes } from "./routes/authRoutes";
import { drawingRoutes } from "./routes/drawingRoutes";
import { exploreRoutes } from "./routes/drawingRoutes";
import { adminRoutes } from "./routes/adminRoutes";

const app = new Hono();

app.use("/api/*", csrf({ origin: process.env.FRONTEND_URL! }));

app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api/auth", authRoutes);
app.route("/api/drawings", drawingRoutes);
app.route("/api/explore", exploreRoutes);
app.route("api/admin", adminRoutes);

app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "Server error" }, 500);
});

serve({ fetch: app.fetch, port: Number(process.env.PORT) || 3000 }, (info) => console.log("API on ${info.port}"));