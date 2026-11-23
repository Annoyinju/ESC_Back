import { createMiddleware } from "hono/factory";
import { getCookie, setCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";
import type { Context } from "hono";

const SECRET = process.env.JWT_SECRET!;
const DAY = 60 * 60 * 24;

export type AuthEnv = { Variables: { userId: number } };

export async function startSession(c: Context, userId: number) {
    const token = await sign(
        { userId, exp: Math.floor(Date.now() / 1000) + DAY },
        SECRET,
        "HS256"
    );
    setCookie(c, "token", token, {
        httpOnly: true,                                   // JS in the browser can't read it
        secure: process.env.NODE_ENV === "production",    // HTTPS only in production
        sameSite: "Lax",
        maxAge: DAY,
        path: "/",
    });
}

// Put this in front of any route that needs a logged-in user
export const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
    const token = getCookie(c, "token");
    if (!token) return c.json({ error: "Not logged in" }, 401);

    try {
        const payload = await verify(token, SECRET, "HS256");
        c.set("userId", payload.userId as number);
    } catch {
        return c.json({ error: "Invalid or expired session" }, 401);
    }
    await next();
});