import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { prisma } from "../db";
import { requireAuth, type AuthEnv } from "../auth";
import { supabase, BUCKET } from "../storage";
import sharp from "sharp";

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

// Returns null for "not provided / blank", a trimmed string for valid text,
// and undefined when the value is invalid (wrong type or too long).
function optionalText(value: unknown, max: number): string | null | undefined {
    if (value === undefined) return null;
    if (typeof value !== "string" || value.length > max) return undefined;
    return value.trim() || null;
}

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
            desc: true,
            createdAt: true,
            imagePath: true,
            thumbPath: true,
            user: { select: { username: true } }, // never userId or email
        },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    // Short-lived links so the browser loads images straight from Supabase
    const { data: signed } = page.length
        ? await supabase.storage
              .from(BUCKET)
              .createSignedUrls(page.map((d) => d.thumbPath ?? d.imagePath), 60 * 60)
        : { data: [] };

    const items = page.map((d, i) => ({
        id: d.id,
        title: d.title,
        desc: d.desc,
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
        select: { id: true, title: true, desc: true, createdAt: true, isPublic: true },
        orderBy: { createdAt: "desc" },
    });
    return c.json(drawings);
});

// Save a new drawing (multipart form: image + optional title, desc, isPublic)
drawingRoutes.post("/", async (c) => {
    const body = await c.req.parseBody();
    const image = body["image"];
    const isPublic = body["isPublic"] === "true"; // anything else means private

    const title = optionalText(body["title"], 100);
    const desc = optionalText(body["desc"], 500);
    if (title === undefined || desc === undefined) {
        return c.json({ error: "Title (max 100) and description (max 500) must be text" }, 400);
    }

    if (!(image instanceof File) || image.type !== "image/png" || image.size > MAX_SIZE) {
        return c.json({ error: "Image must be a PNG under 10 MB" }, 400);
    }

    
        const original = Buffer.from(await image.arrayBuffer());

   
    let thumb: Buffer;
    try {
        thumb = await sharp(original)
            .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true })
            .flatten({ background: "#ffffff" }) // transparent areas become white
            .webp({ quality: 80 })
            .toBuffer();
    } catch {
        return c.json({ error: "Could not read the image" }, 400);
    }

    const id = randomUUID();
    const imagePath = `${id}.png`;
    const thumbPath = `thumbs/${id}.webp`;

    const up1 = await supabase.storage.from(BUCKET)
        .upload(imagePath, original, { contentType: "image/png" });
    const up2 = up1.error ? null : await supabase.storage.from(BUCKET)
        .upload(thumbPath, thumb, { contentType: "image/webp" });

    if (up1.error || up2?.error) {
        console.error("Storage upload failed:", up1.error ?? up2?.error);
        await supabase.storage.from(BUCKET).remove([imagePath, thumbPath]);
        return c.json({ error: "Upload failed" }, 500);
    }

    try {
        const drawing = await prisma.drawing.create({
            data: { title, desc, imagePath, thumbPath, isPublic, userId: c.get("userId") },
            select: { id: true, title: true, desc: true, createdAt: true, isPublic: true },
        });
        return c.json(drawing, 201);
    } catch (e) {
        await supabase.storage.from(BUCKET).remove([imagePath, thumbPath]);
        throw e;
    }
});

// Publish or unpublish one of my drawings
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
    await supabase.storage
    .from(BUCKET)
    .remove([drawing.imagePath, ...(drawing.thumbPath ? [drawing.thumbPath] : [])]);
    return c.body(null, 204);
});