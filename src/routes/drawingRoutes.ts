import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { prisma } from "../db";
import { requireAuth, type AuthEnv } from "../auth";
import { supabase, BUCKET } from "../storage";

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

/* ---------- Public gallery (no login required) ---------- */

export const exploreRoutes = new Hono();

// GET /api/explore?cursor=42&limit=24
exploreRoutes.get("/", async (c) => {
    const limit = Math.min(Number(c.req.query("limit")) || 24, 50);
    const cursor = Number(c.req.query("cursor")) || undefined;

    const rows = await prisma.drawing.findMany({
        where: { isPublic: true },
        orderBy: { id: "desc" },
        take: limit + 1, // one extra to know if there's a next page
        ...(cursor && { cursor: { id: cursor }, skip: 1 }),
        select: {
            id: true,
            title: true,
            createdAt: true,
            imagePath: true,
            user: { select: { username: true } }, // never userId or email
        },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    // Short-lived links so the browser loads images straight from Supabase
    const { data: signed } = page.length
        ? await supabase.storage
              .from(BUCKET)
              .createSignedUrls(page.map((d) => d.imagePath), 60 * 60)
        : { data: [] };

    const items = page.map((d, i) => ({
        id: d.id,
        title: d.title,
        createdAt: d.createdAt,
        author: d.user.username,
        imageUrl: signed?.[i]?.signedUrl ?? null,
    }));

    c.header("Cache-Control", "public, max-age=60");
    return c.json({
        items,
        nextCursor: hasMore ? page[page.length - 1].id : null,
    });
});

/* ---------- Private routes (login required) ---------- */

export const drawingRoutes = new Hono<AuthEnv>();
drawingRoutes.use("*", requireAuth);

// List my drawings (metadata only)
drawingRoutes.get("/", async (c) => {
    const drawings = await prisma.drawing.findMany({
        where: { userId: c.get("userId") },
        select: { id: true, title: true, createdAt: true, isPublic: true },
        orderBy: { createdAt: "desc" },
    });
    return c.json(drawings);
});

// Save a new drawing (multipart form: optional title + image + optional isPublic)
drawingRoutes.post("/", async (c) => {
    const body = await c.req.parseBody();
    const rawTitle = body["title"];
    const image = body["image"];
    const isPublic = body["isPublic"] === "true"; // anything else means private

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


    const imagePath = `${randomUUID()}.png`;

    const { error } = await supabase.storage
        .from(BUCKET)
        .upload(imagePath, await image.arrayBuffer(), { contentType: "image/png" });
    if (error) {
        console.error("Storage upload failed:", error);
        return c.json({ error: "Upload failed" }, 500);
    }

    try {
        const drawing = await prisma.drawing.create({
            data: { title, imagePath, isPublic, userId: c.get("userId") },
            select: { id: true, title: true, createdAt: true, isPublic: true },
        });
        return c.json(drawing, 201);
    } catch (e) {
        // Don't leave an orphan file if the database insert fails
        await supabase.storage.from(BUCKET).remove([imagePath]);
        throw e;
    }
});


drawingRoutes.patch("/:id", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (typeof body?.isPublic !== "boolean") {
        return c.json({ error: "Invalid data" }, 400);
    }

    // updateMany lets us filter by owner in the same query
    const result = await prisma.drawing.updateMany({
        where: { id: Number(c.req.param("id")), userId: c.get("userId") },
        data: { isPublic: body.isPublic },
    });
    if (result.count === 0) return c.json({ error: "Not found" }, 404);

    return c.json({ ok: true });
});

// Get one of my drawings' image
drawingRoutes.get("/:id/image", async (c) => {
    const drawing = await prisma.drawing.findFirst({
        where: { id: Number(c.req.param("id")), userId: c.get("userId") },
    });
    if (!drawing) return c.json({ error: "Not found" }, 404);

    const { data, error } = await supabase.storage
        .from(BUCKET)
        .download(drawing.imagePath);
    if (error || !data) return c.json({ error: "Not found" }, 404);

    return c.body(await data.arrayBuffer(), 200, { "Content-Type": "image/png" });
});

// Delete a drawing
drawingRoutes.delete("/:id", async (c) => {
    const drawing = await prisma.drawing.findFirst({
        where: { id: Number(c.req.param("id")), userId: c.get("userId") },
    });
    if (!drawing) return c.json({ error: "Not found" }, 404);

    await prisma.drawing.delete({ where: { id: drawing.id } });
    await supabase.storage.from(BUCKET).remove([drawing.imagePath]);
    return c.body(null, 204);})