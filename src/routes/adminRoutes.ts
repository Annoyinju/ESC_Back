import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../db";
import { supabase, BUCKET } from "../storage";
import { requireAuth, requireRole, type AuthEnv } from "../auth";

export const adminRoutes = new Hono<AuthEnv>();
adminRoutes.use("*", requireAuth, requireRole("ADMIN"));


adminRoutes.get("/users", async (c) => {
    const q = (c.req.query("q") ?? "").trim().slice(0, 100);
    const cursor = Number(c.req.query("cursor")) || undefined;
    const limit = 20;

    const rows = await prisma.user.findMany({
        where: q
            ? {
                  OR: [
                      { email: { contains: q, mode: "insensitive" } },
                      { username: { contains: q, mode: "insensitive" } },
                  ],
              }
            : {},
        orderBy: { id: "asc" },
        take: limit + 1,
        ...(cursor && { cursor: { id: cursor }, skip: 1 }),
        select: {
            id: true, email: true, username: true, role: true, createdAt: true,
            _count: { select: { drawings: true } },
        },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return c.json({ items: page, nextCursor: hasMore ? page[page.length - 1].id : null });
});

adminRoutes.patch(
    "/users/:id/role",
    zValidator("json", z.object({ role: z.enum(["USER_NOAUTH", "USER_AUTH", "ADMIN"]) })),
    async (c) => {
        const id = Number(c.req.param("id"));
        if (!Number.isInteger(id)) return c.json({ error: "Invalid id" }, 400);
        if (id === c.get("userId")) return c.json({ error: "You can't change your own role" }, 400);

        const { role } = c.req.valid("json");
        const result = await prisma.user.updateMany({ where: { id }, data: { role } });
        if (result.count === 0) return c.json({ error: "Not found" }, 404);
        return c.json({ ok: true });
    }
);

adminRoutes.delete("/users/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "Invalid id" }, 400);
    if (id === c.get("userId")) return c.json({ error: "You can't delete your own account here" }, 400);

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return c.json({ error: "Not found" }, 404);

    const drawings = await prisma.drawing.findMany({
        where: { userId: id },
        select: { imagePath: true, thumbPath: true },
    });

    await prisma.$transaction([
        prisma.drawing.deleteMany({ where: { userId: id } }),
        prisma.user.delete({ where: { id } }),
    ]);

    const paths = drawings.flatMap((d) => [d.imagePath, ...(d.thumbPath ? [d.thumbPath] : [])]);
    if (paths.length) await supabase.storage.from(BUCKET).remove(paths);

    return c.body(null, 204);
});