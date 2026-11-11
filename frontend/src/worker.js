
const corsHeaders = {
  "Access-Control-Allow-Origin": "https://fexxxxyuiop.github.io",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Telegram-Init-Data"
};

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

async function verifyTelegram(initData, botToken) {
  if (!initData || !botToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;

  params.delete("hash");

  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;

  const dataCheckString = [...params.entries()]
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
    encoder.encode(dataCheckString)
  );

  const calculatedHash = [...new Uint8Array(signature)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  if (calculatedHash !== hash) return null;

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

async function getListing(env, id) {
  const listing = await env.DB.prepare(
    "SELECT * FROM listings WHERE id = ?"
  ).bind(id).first();

  if (!listing) return null;

  const options = await env.DB.prepare(`
    SELECT id, duration_days, price, is_active
    FROM rental_options
    WHERE listing_id = ?
    ORDER BY duration_days ASC
  `).bind(id).all();

  return { ...listing, rental_options: options.results || [] };
}

async function saveOptions(env, listingId, options) {
  if (!Array.isArray(options)) return;

  await env.DB.prepare(
    "DELETE FROM rental_options WHERE listing_id = ?"
  ).bind(listingId).run();

  for (const option of options) {
    const days = Number(option.duration_days);
    const price = Number(option.price);

    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      throw new Error("Invalid rental duration");
    }

    if (!Number.isFinite(price) || price < 0) {
      throw new Error("Invalid rental price");
    }

    await env.DB.prepare(`
      INSERT INTO rental_options
      (listing_id, duration_days, price, is_active)
      VALUES (?, ?, ?, 1)
    `).bind(listingId, days, price).run();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (path === "/health") {
        return response({ ok: true, service: "prestige-market-api" });
      }

      if (path === "/") {
        return response({
          service: "Prestige Market API",
          status: "online"
        });
      }

      // Публичный каталог
      if (path === "/api/listings" && method === "GET") {
        const result = await env.DB.prepare(`
          SELECT * FROM listings
          WHERE status = 'APPROVED'
          ORDER BY created_at DESC
        `).all();

        const listings = [];

        for (const item of result.results || []) {
          listings.push(await getListing(env, item.id));
        }

        return response({ ok: true, listings });
      }

      // Одна карточка подарка
      const listingMatch = path.match(/^\/api\/listings\/(\d+)$/);

      if (listingMatch && method === "GET") {
        const item = await getListing(env, Number(listingMatch[1]));

        if (!item || item.status !== "APPROVED") {
          return response({ error: "Gift not found" }, 404);
        }

        return response({ ok: true, listing: item });
      }

      // Все действия ниже требуют администратора
      if (path.startsWith("/api/admin/")) {
        const admin = await getAdmin(request, env);

        if (!admin) {
          return response({ error: "Admin access denied" }, 403);
        }

        // Список подарков
        if (path === "/api/admin/listings" && method === "GET") {
          const result = await env.DB.prepare(`
            SELECT * FROM listings ORDER BY created_at DESC
          `).all();

          const listings = [];

          for (const item of result.results || []) {
            listings.push(await getListing(env, item.id));
          }

          return response({ ok: true, listings });
        }

        // Добавление подарка
        if (path === "/api/admin/listings" && method === "POST") {
          const body = await request.json();

          const title = String(body.title || "").trim();
          const category = String(body.category || "NFT").trim();
          const description = String(body.description || "").trim();
          const imageUrl = String(body.image_url || "").trim();
          const options = body.rental_options;

          if (!title || !Array.isArray(options) || options.length === 0) {
            return response({
              error: "Title and rental options are required"
            }, 400);
          }

          const firstPrice = Number(options[0].price);

          if (!Number.isFinite(firstPrice) || firstPrice < 0) {
            return response({ error: "Invalid price" }, 400);
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
          }, 201);
        }

        // Изменение подарка
        const editMatch = path.match(/^\/api\/admin\/listings\/(\d+)$/);

        if (editMatch && method === "PATCH") {
          const id = Number(editMatch[1]);
          const body = await request.json();

          const existing = await getListing(env, id);
          if (!existing) return response({ error: "Not found" }, 404);

          const title = String(body.title ?? existing.title).trim();
          const description = String(body.description ?? existing.description ?? "");
          const category = String(body.category ?? existing.category);
          const imageUrl = String(body.image_url ?? existing.image_url ?? "");

          const status = body.status ?? existing.status;
          if (!["APPROVED", "PENDING", "HIDDEN"].includes(status)) {
            return response({ error: "Invalid status" }, 400);
          }

          await env.DB.prepare(`
            UPDATE listings
            SET title = ?, description = ?, category = ?,
                image_url = ?, status = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).bind(
            title, description, category, imageUrl, status, id
          ).run();

          if (body.rental_options !== undefined) {
            if (!Array.isArray(body.rental_options) || !body.rental_options.length) {
              return response({ error: "At least one rental option required" }, 400);
            }

            await saveOptions(env, id, body.rental_options);
          }

          await audit(env, admin.id, "edit_listing", String(id));

          return response({
            ok: true,
            listing: await getListing(env, id)
          });
        }

        // Удаление подарка
        if (editMatch && method === "DELETE") {
          const id = Number(editMatch[1]);

          await env.DB.prepare(
            "DELETE FROM rental_options WHERE listing_id = ?"
          ).bind(id).run();

          await env.DB.prepare(
            "DELETE FROM listings WHERE id = ?"
          ).bind(id).run();

          await audit(env, admin.id, "delete_listing", String(id));

          return response({ ok: true, deleted: id });
        }

        return response({ error: "Admin route not found" }, 404);
      }

      return response({ error: "Not found" }, 404);

    } catch (error) {
      return response({
        error: "Internal server error",
        details: error.message
      }, 500);
    }
  }
};
