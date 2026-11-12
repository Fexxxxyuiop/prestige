const allowedOrigins = [
  "https://fexxxxyuiop.github.io",
  "https://web.telegram.org",
  "https://t.me"
];

function getCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = allowedOrigins.includes(origin);

  return {
    "Access-Control-Allow-Origin": allowed
      ? origin
      : "https://fexxxxyuiop.github.io",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Telegram-Init-Data",
    "Vary": "Origin"
  };
}

function response(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json"
    }
  });
}

async function getRates() {
  const [rubResponse, tonResponse] = await Promise.all([
    fetch("https://open.er-api.com/v6/latest/USD", {
      cf: { cacheTtl: 300, cacheEverything: true }
    }),
    fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd",
      { cf: { cacheTtl: 300, cacheEverything: true } }
    )
  ]);

  if (!rubResponse.ok || !tonResponse.ok) {
    throw new Error("Exchange rate provider unavailable");
  }

  const rubData = await rubResponse.json();
  const tonData = await tonResponse.json();

  const rub = Number(rubData?.rates?.RUB);
  const tonUsd = Number(tonData?.["the-open-network"]?.usd);

  if (
    !Number.isFinite(rub) ||
    rub <= 0 ||
    !Number.isFinite(tonUsd) ||
    tonUsd <= 0
  ) {
    throw new Error("Invalid exchange rates");
  }

  return {
    RUB: rub,
    TON: 1 / tonUsd,
    updated_at: new Date().toISOString()
  };
}

async function verifyTelegram(initData, botToken) {
  if (!initData || !botToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;

  params.delete("hash");

  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;

  const checkString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const encoder = new TextEncoder();

  const secretKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const secret = await crypto.subtle.sign(
    "HMAC",
    secretKey,
    encoder.encode(botToken)
  );

  const signingKey = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    signingKey,
    encoder.encode(checkString)
  );

  const calculated = [...new Uint8Array(signature)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  if (calculated !== hash) return null;

  try {
    return JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
}

async function getAdmin(request, env) {
  const initData = request.headers.get("X-Telegram-Init-Data");
  const user = await verifyTelegram(initData, env.BOT_TOKEN);

  if (!user?.id) return null;

  const admins = (env.ADMIN_IDS || "")
    .split(",")
    .map(id => id.trim());

  return admins.includes(String(user.id)) ? user : null;
}

async function audit(env, adminId, action, details = "") {
  await env.DB.prepare(`
    INSERT INTO admin_audit
    (admin_telegram_id, action, details)
    VALUES (?, ?, ?)
  `).bind(String(adminId), action, details).run();
}

let currencyMigrationPromise = null;

async function ensureCurrencyColumn(env) {
  if (!currencyMigrationPromise) {
    currencyMigrationPromise = (async () => {
      const info = await env.DB.prepare(
        "PRAGMA table_info(rental_options)"
      ).all();

      const exists = (info.results || []).some(
        column => column.name === "currency"
      );

      if (!exists) {
        try {
          await env.DB.prepare(`
            ALTER TABLE rental_options
            ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD'
          `).run();
        } catch (error) {
          const refreshed = await env.DB.prepare(
            "PRAGMA table_info(rental_options)"
          ).all();

          const added = (refreshed.results || []).some(
            column => column.name === "currency"
          );

          if (!added) throw error;
        }
      }
    })().catch(error => {
      currencyMigrationPromise = null;
      throw error;
    });
  }

  return currencyMigrationPromise;
}

async function getListing(env, id) {
  const listing = await env.DB.prepare(
    "SELECT * FROM listings WHERE id = ?"
  ).bind(id).first();

  if (!listing) return null;

  const options = await env.DB.prepare(`
    SELECT id, duration_days, price, currency, is_active
    FROM rental_options
    WHERE listing_id = ?
    ORDER BY duration_days ASC
  `).bind(id).all();

  return {
    ...listing,
    rental_options: options.results || []
  };
}

async function saveOptions(env, listingId, options) {
  if (!Array.isArray(options)) return;

  for (const option of options) {
    const days = Number(option.duration_days);
    const price = Number(option.price);

    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      throw new Error("Invalid rental duration");
    }

    if (!Number.isFinite(price) || price < 0) {
      throw new Error("Invalid rental price");
    }

    if (
      option.currency &&
      !["USD", "RUB", "TON"].includes(
        String(option.currency).toUpperCase()
      )
    ) {
      throw new Error("Invalid currency");
    }
  }

  await env.DB.prepare(
    "DELETE FROM rental_options WHERE listing_id = ?"
  ).bind(listingId).run();

  for (const option of options) {
    const days = Number(option.duration_days);
    const price = Number(option.price);

    await env.DB.prepare(`
      INSERT INTO rental_options
      (listing_id, duration_days, price, currency, is_active)
      VALUES (?, ?, ?, 'USD', 1)
    `).bind(listingId, days, price).run();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const cors = getCorsHeaders(request);

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors
      });
    }

    try {
      if (path === "/health") {
        return response({
          ok: true,
          service: "prestige-market-api"
        }, 200, cors);
      }

      if (path === "/") {
        return response({
          service: "Prestige Market API",
          status: "online"
        }, 200, cors);
      }

      if (path === "/api/rates" && method === "GET") {
        try {
          const rates = await getRates();
          return response({
            ok: true,
            ...rates
          }, 200, {
            ...cors,
            "Cache-Control": "public, max-age=300"
          });
        } catch (error) {
          return response({
            ok: false,
            error: "Курсы временно недоступны"
          }, 503, cors);
        }
      }

      await ensureCurrencyColumn(env);

      if (path === "/api/listings" && method === "GET") {
        const result = await env.DB.prepare(`
          SELECT * FROM listings
          WHERE status = 'APPROVED'
          ORDER BY created_at DESC
        `).all();

        const listings = [];

        for (const item of result.results || []) {
          const listing = await getListing(env, item.id);
          if (listing) listings.push(listing);
        }

        return response({
          ok: true,
          listings
        }, 200, cors);
      }

      const listingMatch = path.match(/^\/api\/listings\/(\d+)$/);

      if (listingMatch && method === "GET") {
        const item = await getListing(env, Number(listingMatch[1]));

        if (!item || item.status !== "APPROVED") {
          return response({
            error: "Gift not found"
          }, 404, cors);
        }

        return response({
          ok: true,
          listing: item
        }, 200, cors);
      }

      if (path.startsWith("/api/admin/")) {
        const admin = await getAdmin(request, env);

        if (!admin) {
          return response({
            error: "Admin access denied"
          }, 403, cors);
        }

        if (path === "/api/admin/listings" && method === "GET") {
          const result = await env.DB.prepare(`
            SELECT * FROM listings
            ORDER BY created_at DESC
          `).all();

          const listings = [];

          for (const item of result.results || []) {
            const listing = await getListing(env, item.id);
            if (listing) listings.push(listing);
          }

          return response({
            ok: true,
            listings
          }, 200, cors);
        }

        if (path === "/api/admin/listings" && method === "POST") {
          const body = await request.json();

          const title = String(body.title || "").trim();
          const category = String(body.category || "gifts").trim();
          const description = String(body.description || "").trim();
          const imageUrl = String(body.image_url || "").trim();
          const options = body.rental_options;

          if (!title || !Array.isArray(options) || options.length === 0) {
            return response({
              error: "Title and rental options are required"
            }, 400, cors);
          }

          const firstPrice = Number(options[0].price);

          if (!Number.isFinite(firstPrice) || firstPrice < 0) {
            return response({
              error: "Invalid price"
            }, 400, cors);
          }

          const result = await env.DB.prepare(`
            INSERT INTO listings
            (title, description, category, image_url, price,
             rental_period, status, created_by)
            VALUES (?, ?, ?, ?, ?, ?, 'APPROVED', ?)
          `).bind(
            title,
            description,
            category,
            imageUrl,
            firstPrice,
            `${options[0].duration_days} days`,
            String(admin.id)
          ).run();

          const id = result.meta.last_row_id;

          await saveOptions(env, id, options);
          await audit(env, admin.id, "create_listing", String(id));

          return response({
            ok: true,
            listing: await getListing(env, id)
          }, 201, cors);
        }

        const editMatch = path.match(
          /^\/api\/admin\/listings\/(\d+)$/
        );

        if (editMatch && method === "PATCH") {
          const id = Number(editMatch[1]);
          const body = await request.json();

          const existing = await getListing(env, id);

          if (!existing) {
            return response({
              error: "Not found"
            }, 404, cors);
          }

          const title = String(body.title ?? existing.title).trim();
          const description = String(
            body.description ?? existing.description ?? ""
          );
          const category = String(
            body.category ?? existing.category
          );
          const imageUrl = String(
            body.image_url ?? existing.image_url ?? ""
          );
          const status = body.status ?? existing.status;

          if (!["APPROVED", "PENDING", "HIDDEN"].includes(status)) {
            return response({
              error: "Invalid status"
            }, 400, cors);
          }

          await env.DB.prepare(`
            UPDATE listings
            SET title = ?, description = ?, category = ?,
                image_url = ?, status = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).bind(
            title,
            description,
            category,
            imageUrl,
            status,
            id
          ).run();

          if (body.rental_options !== undefined) {
            if (
              !Array.isArray(body.rental_options) ||
              !body.rental_options.length
            ) {
              return response({
                error: "At least one rental option required"
              }, 400, cors);
            }

            await saveOptions(env, id, body.rental_options);
          }

          await audit(env, admin.id, "edit_listing", String(id));

          return response({
            ok: true,
            listing: await getListing(env, id)
          }, 200, cors);
        }

        if (editMatch && method === "DELETE") {
          const id = Number(editMatch[1]);

          await env.DB.prepare(
            "DELETE FROM rental_options WHERE listing_id = ?"
          ).bind(id).run();

          await env.DB.prepare(
            "DELETE FROM listings WHERE id = ?"
          ).bind(id).run();

          await audit(env, admin.id, "delete_listing", String(id));

          return response({
            ok: true,
            deleted: id
          }, 200, cors);
        }

        return response({
          error: "Admin route not found"
        }, 404, cors);
      }

      return response({
        error: "Not found"
      }, 404, cors);

    } catch (error) {
      return response({
        error: "Internal server error",
        details: error?.message || "Unknown error"
      }, 500, cors);
    }
  }
};
