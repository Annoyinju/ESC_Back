import { Hono } from "hono";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prisma } from "../db";
import { requireAuth, type AuthEnv } from "../auth";

const UPLOAD_DIR = path.resolve("uploads");
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

export const drawingRoutes = new Hono<AuthEnv>();
drawingRoutes.use("*", requireAuth); // every route below needs a login

// List my drawings (metadata only)
drawingRoutes.get("/", async (c) => {
    const drawings = await prisma.drawing.findMany({
        where: { userId: c.get("userId") },
        select: { id: true, title: true, createdAt: true },
        orderBy: { createdAt: "desc" },
    });
    return c.json(drawings);
});

// Save a new drawing (multipart form: optional title + image)
drawingRoutes.post("/", async (c) => {
    const body = await c.req.parseBody();
    const rawTitle = body["title"];
    const image = body["image"];

    // Title is optional: missing or blank means "no title"
    let title: string | null = null;
    if (rawTitle !== undefined) {
        if (typeof rawTitle !== "string" || rawTitle.length > 100) {
            return c.json({ error: "Title must be text of at most 100 characters" }, 400);
        }
        title = rawTitle.trim() || null;
    }

    if (!(image instanceof File) || image.type !== "image/png" || image.size > MAX_SIZE) {
        return c.json({ error: "Image must be a PNG under 10 MB" }, 400);
    }

    // The server picks the filename, never the client
    const imagePath = `${randomUUID()}.png`;
    await mkdir(UPLOAD_DIR, { recursive: true });
    await writeFile(path.join(UPLOAD_DIR, imagePath), Buffer.from(await image.arrayBuffer()));

    const drawing = await prisma.drawing.create({
        data: { title, imagePath, userId: c.get("userId") },
        select: { id: true, title: true, createdAt: true },
    });
    return c.json(drawing, 201);
});

// Get one drawing's image
drawingRoutes.get("/:id/image", async (c) => {
    const drawing = await prisma.drawing.findFirst({
        where: { id: Number(c.req.param("id")), userId: c.get("userId") },
    });
    if (!drawing) return c.json({ error: "Not found" }, 404);

    const data = await readFile(path.join(UPLOAD_DIR, drawing.imagePath));
    return c.body(new Uint8Array(data), 200, { "Content-Type": "image/png" });
});

// Delete a drawing
drawingRoutes.delete("/:id", async (c) => {
    const drawing = await prisma.drawing.findFirst({
        where: { id: Number(c.req.param("id")), userId: c.get("userId") },
    });
    if (!drawing) return c.json({ error: "Not found" }, 404);

    await prisma.drawing.delete({ where: { id: drawing.id } });
    await unlink(path.join(UPLOAD_DIR, drawing.imagePath)).catch(() => {});
    return c.body(null, 204);
});