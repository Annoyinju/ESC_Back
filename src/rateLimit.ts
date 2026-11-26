import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

interface Entry { count: number; resetAt: number }

export function createLimiter(max: number, windowMs: number) {
    const hits = new Map<string, Entry>();

    
    setInterval(() => {
        const now = Date.now();
        for (const [key, e] of hits) if (e.resetAt <= now) hits.delete(key);
    }, 60_000).unref();

    return {
        // Seconds until allowed again, or 0 if not blocked
        blocked(key: string): number {
            const e = hits.get(key);
            if (!e || e.resetAt <= Date.now() || e.count < max) return 0;
            return Math.ceil((e.resetAt - Date.now()) / 1000);
        },
        hit(key: string) {
            const now = Date.now();
            const e = hits.get(key);
            if (!e || e.resetAt <= now) hits.set(key, { count: 1, resetAt: now + windowMs });
            else e.count++;
        },
        reset(key: string) {
            hits.delete(key);
        },
    };
}

export function clientIp(c: Context): string {
    const forwarded = c.req.header("x-forwarded-for");
    return forwarded?.split(",")[0].trim() || "unknown";
}

// Simple per-IP limit for any route (counts every request, not just failures)
export function ipRateLimit(max: number, windowMs: number) {
    const limiter = createLimiter(max, windowMs);
    return createMiddleware(async (c, next) => {
        const ip = clientIp(c);
        const wait = limiter.blocked(ip);
        if (wait) {
            c.header("Retry-After", String(wait));
            return c.json({ error: "Too many requests. Try again later." }, 429);
        }
        limiter.hit(ip);
        await next();
    });
}