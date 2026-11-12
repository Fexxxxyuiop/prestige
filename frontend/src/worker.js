
const allowedOrigins = [
  "https://fexxxxyuiop.github.io",
  "https://web.telegram.org",
  "https://t.me"
];

function getCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": allowedOrigins.includes(origin)
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
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

// TELEGRAM AUTH

async function verifyTelegram(initData, botToken) {
  if (!initData || !botToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");

  if (!hash) return null;

  params.delete("hash");

  const authDate = Number(params.get("auth_date"));
  const now = Math.floor(Date.now() / 1000);

  if (!authDate || authDate > now + 60 || now - authDate > 86400) {
    return null;
  }

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
  const user = await verifyTelegram(
    request.headers.get("X-Telegram-Init-Data"),
    env.BOT_TOKEN
  );

  if (!user?.id) return null;

  const admins = (env.ADMIN_IDS || "")
    .split(",")
    .map(id => id.trim());

  return admins.includes(String(user.id)) ? user : null;
}

// ADMIN AUDIT

async function audit(env, adminId, action, details = "") {
  await env.DB.prepare(`
    INSERT INTO admin_audit
      (admin_telegram_id, action, details)
    VALUES (?, ?, ?)
  `).bind(String(adminId), action, details).run();
}

// DATABASE MIGRATION

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

      await env.DB.prepare(`
        UPDATE rental_options
        SET currency = 'USDT'
        WHERE currency = 'USD'
      `).run();

      await env.DB.prepare(`
        DELETE FROM rental_options
        WHERE currency = 'TON'
      `).run();
    })().catch(error => {
      currencyMigrationPromise = null;
      throw error;
    });
  }

  return currencyMigrationPromise;
}

// LISTINGS

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

// RENTAL OPTIONS

async function saveOptions(env, listingId, options) {
  if (!Array.isArray(options)) return;

  for (const option of options) {
    const days = Number(option.duration_days);
    const usdt = Number(option.price_usdt ?? option.price ?? 0);
    const rub = Number(option.price_rub ?? 0);

    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      throw new Error("Invalid rental duration");
    }

    if (
      !Number.isFinite(usdt) || usdt <= 0 ||
      !Number.isFinite(rub) || rub <= 0
    ) {
      throw new Error("Invalid rental price");
    }
  }

  await env.DB.prepare(
    "DELETE FROM rental_options WHERE listing_id = ?"
  ).bind(listingId).run();

  for (const option of options) {
    const days = Number(option.duration_days);
    const usdt = Number(option.price_usdt ?? option.price ?? 0);
    const rub = Number(option.price_rub ?? 0);

    await env.DB.prepare(`
      INSERT INTO rental_options
        (listing_id, duration_days, price, currency, is_active)
      VALUES (?, ?, ?, 'USDT', 1)
    `).bind(listingId, days, usdt).run();

    await env.DB.prepare(`
      INSERT INTO rental_options
        (listing_id, duration_days, price, currency, is_active)
      VALUES (?, ?, ?, 'RUB', 1)
    `).bind(listingId, days, rub).run();
  }
}

// ORDERS SYSTEM

async function ensureOrdersTable(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL UNIQUE,
      username TEXT,
      first_name TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      listing_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      total_price REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      user_telegram_id TEXT,
      username TEXT,
      first_name TEXT,
      listing_title TEXT,
      category TEXT,
      duration_days INTEGER DEFAULT 1,
      currency TEXT DEFAULT 'USDT',
      amount REAL DEFAULT 0,
      updated_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (listing_id) REFERENCES listings(id)
    )
  `).run();
}

// REGISTER / UPDATE USER

async function getOrCreateUser(env, telegramUser) {
  const telegramId = String(telegramUser.id);
  const username = String(telegramUser.username || "");
  const firstName = String(telegramUser.first_name || "");

  await env.DB.prepare(`
    INSERT INTO users (telegram_id, username, first_name)
    VALUES (?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name
  `).bind(
    telegramId,
    username,
    firstName
  ).run();

  const dbUser = await env.DB.prepare(`
    SELECT id
    FROM users
    WHERE telegram_id = ?
  `).bind(telegramId).first();

  if (!dbUser?.id) {
    throw new Error("Could not create or find user");
  }

  return {
    id: Number(dbUser.id),
    telegramId,
    username,
    firstName
  };
}

// TELEGRAM NOTIFICATIONS

async function sendTelegramMessage(env, chatId, message) {
  if (!env.BOT_TOKEN || !chatId) return false;

  try {
    const result = await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: message
        })
      }
    );

    return result.ok;
  } catch (error) {
    console.error("TELEGRAM NOTIFICATION ERROR:", error);
    return false;
  }
}

function escapeText(value) {
  return String(value || "").replace(/[<>&]/g, "");
}

// MAIN WORKER

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
      // HEALTH CHECK

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

      await ensureCurrencyColumn(env);

      // PUBLIC LISTINGS

      if (path === "/api/listings" && method === "GET") {
        const result = await env.DB.prepare(`
          SELECT *
          FROM listings
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

      // SINGLE LISTING

      const listingMatch = path.match(/^\/api\/listings\/(\d+)$/);

      if (listingMatch && method === "GET") {
        const item = await getListing(
          env,
          Number(listingMatch[1])
        );

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

      // CREATE ORDER

      if (path === "/api/orders" && method === "POST") {
        const telegramUser = await verifyTelegram(
          request.headers.get("X-Telegram-Init-Data"),
          env.BOT_TOKEN
        );

        if (!telegramUser?.id) {
          return response({
            error: "Telegram authorization required"
          }, 401, cors);
        }

        await ensureOrdersTable(env);

        const body = await request.json();

        const listingId = Number(body.listing_id);
        const durationDays = Number(body.duration_days);
        const currency = String(body.currency || "")
          .trim()
          .toUpperCase();

        if (
          !Number.isInteger(listingId) ||
          listingId < 1 ||
          !Number.isInteger(durationDays) ||
          durationDays < 1 ||
          !["USDT", "RUB"].includes(currency)
        ) {
          return response({
            error: "Invalid order data"
          }, 400, cors);
        }

        const listing = await getListing(env, listingId);

        if (!listing || listing.status !== "APPROVED") {
          return response({
            error: "Product not available"
          }, 404, cors);
        }

        const option = listing.rental_options.find(item =>
          Number(item.duration_days) === durationDays &&
          String(item.currency).toUpperCase() === currency &&
          Number(item.is_active) !== 0
        );

        if (
          !option ||
          !Number.isFinite(Number(option.price)) ||
          Number(option.price) <= 0
        ) {
          return response({
            error: "Selected option unavailable"
          }, 400, cors);
        }

        const dbUser = await getOrCreateUser(env, telegramUser);
        const amount = Number(option.price);

        const result = await env.DB.prepare(`
          INSERT INTO orders (
            user_id,
            listing_id,
            status,
            total_price,
            user_telegram_id,
            username,
            first_name,
            listing_title,
            category,
            duration_days,
            currency,
            amount
          )
          VALUES (?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          dbUser.id,
          listingId,
          amount,
          dbUser.telegramId,
          dbUser.username,
          dbUser.firstName,
          listing.title,
          listing.category,
          durationDays,
          currency,
          amount
        ).run();

        const orderId = result.meta.last_row_id;

        const admins = (env.ADMIN_IDS || "")
          .split(",")
          .map(id => id.trim())
          .filter(Boolean);

        const notification =
          `НОВАЯ ЗАЯВКА №${orderId}\n\n` +
          `Товар: ${escapeText(listing.title)}\n` +
          `Категория: ${escapeText(listing.category)}\n` +
          `Срок: ${durationDays} дней\n` +
          `Цена: ${amount} ${currency}\n\n` +
          `Пользователь: ${escapeText(dbUser.firstName)}\n` +
          `Username: @${escapeText(dbUser.username || "не указан")}\n` +
          `Telegram ID: ${dbUser.telegramId}`;

        for (const adminId of admins) {
          await sendTelegramMessage(
            env,
            adminId,
            notification
          );
        }

        return response({
          ok: true,
          order_id: orderId,
          message: "Заявка создана"
        }, 201, cors);
      }

      // USER ORDERS

      if (path === "/api/orders" && method === "GET") {
        const user = await verifyTelegram(
          request.headers.get("X-Telegram-Init-Data"),
          env.BOT_TOKEN
        );

        if (!user?.id) {
          return response({
            error: "Telegram authorization required"
          }, 401, cors);
        }

        await ensureOrdersTable(env);

        const result = await env.DB.prepare(`
          SELECT *
          FROM orders
          WHERE user_telegram_id = ?
          ORDER BY created_at DESC
        `).bind(String(user.id)).all();

        return response({
          ok: true,
          orders: result.results || []
        }, 200, cors);
      }

      // ADMIN ROUTES

      if (path.startsWith("/api/admin/")) {
        const admin = await getAdmin(request, env);

        if (!admin) {
          return response({
            error: "Admin access denied"
          }, 403, cors);
        }

        // ADMIN ORDERS: PENDING / ACTIVE / HISTORY

        if (path === "/api/admin/orders" && method === "GET") {
          await ensureOrdersTable(env);

          const view = url.searchParams.get("view") || "pending";

          let where = "";

          if (view === "pending") {
            where = "WHERE status IN ('NEW', 'PENDING')";
          } else if (view === "active") {
            where = "WHERE status = 'ACCEPTED'";
          } else if (view === "history") {
            where = "WHERE status IN ('REJECTED', 'COMPLETED')";
          } else if (view === "all") {
            where = "";
          } else {
            return response({
              error: "Invalid order view"
            }, 400, cors);
          }

          const result = await env.DB.prepare(`
            SELECT *
            FROM orders
            ${where}
            ORDER BY created_at DESC
          `).all();

          return response({
            ok: true,
            view,
            orders: result.results || []
          }, 200, cors);
        }

        // CHANGE ORDER STATUS

        const orderMatch = path.match(
          /^\/api\/admin\/orders\/(\d+)$/
        );

        if (orderMatch && method === "PATCH") {
          await ensureOrdersTable(env);

          const orderId = Number(orderMatch[1]);
          const body = await request.json();
          const status = String(body.status || "");

          if (!["ACCEPTED", "REJECTED", "COMPLETED"].includes(status)) {
            return response({
              error: "Invalid status"
            }, 400, cors);
          }

          const order = await env.DB.prepare(`
            SELECT *
            FROM orders
            WHERE id = ?
          `).bind(orderId).first();

          if (!order) {
            return response({
              error: "Order not found"
            }, 404, cors);
          }

          // Не разрешаем завершать заявку, которая ещё не принята.
          if (
            status === "COMPLETED" &&
            order.status !== "ACCEPTED"
          ) {
            return response({
              error: "Only accepted orders can be completed"
            }, 400, cors);
          }

          // Новую заявку можно принять или отклонить.
          if (
            ["NEW", "PENDING"].includes(order.status) &&
            !["ACCEPTED", "REJECTED"].includes(status)
          ) {
            return response({
              error: "Invalid status transition"
            }, 400, cors);
          }

          // Принятую заявку можно завершить или отклонить.
          if (
            order.status === "ACCEPTED" &&
            !["COMPLETED", "REJECTED"].includes(status)
          ) {
            return response({
              error: "Invalid status transition"
            }, 400, cors);
          }

          // Уже обработанные заявки нельзя менять повторно.
          if (["REJECTED", "COMPLETED"].includes(order.status)) {
            return response({
              error: "Order is already closed"
            }, 400, cors);
          }

          await env.DB.prepare(`
            UPDATE orders
            SET status = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).bind(status, orderId).run();

          const statusLabels = {
            ACCEPTED: "принята",
            REJECTED: "отклонена",
            COMPLETED: "выполнена"
          };

          await sendTelegramMessage(
            env,
            order.user_telegram_id,
            `Статус вашей заявки №${orderId}: ${statusLabels[status]}.`
          );

          await audit(
            env,
            admin.id,
            "order_status",
            `${orderId}: ${status}`
          );

          return response({
            ok: true,
            order_id: orderId,
            status
          }, 200, cors);
        }

        // ADMIN LISTINGS

        if (
          path === "/api/admin/listings" &&
          method === "GET"
        ) {
          const result = await env.DB.prepare(`
            SELECT *
            FROM listings
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

        // CREATE LISTING

        if (
          path === "/api/admin/listings" &&
          method === "POST"
        ) {
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

          const firstPrice = Number(
            options[0].price_usdt ?? options[0].price ?? 0
          );

          if (!Number.isFinite(firstPrice) || firstPrice <= 0) {
            return response({
              error: "Invalid price"
            }, 400, cors);
          }

          const result = await env.DB.prepare(`
            INSERT INTO listings (
              title,
              description,
              category,
              image_url,
              price,
              rental_period,
              status,
              created_by
            )
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
          await audit(
            env,
            admin.id,
            "create_listing",
            String(id)
          );

          return response({
            ok: true,
            listing: await getListing(env, id)
          }, 201, cors);
        }

        // EDIT LISTING

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

          const title = String(
            body.title ?? existing.title
          ).trim();

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
            SET
              title = ?,
              description = ?,
              category = ?,
              image_url = ?,
              status = ?,
              updated_at = CURRENT_TIMESTAMP
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

            await saveOptions(
              env,
              id,
              body.rental_options
            );
          }

          await audit(
            env,
            admin.id,
            "edit_listing",
            String(id)
          );

          return response({
            ok: true,
            listing: await getListing(env, id)
          }, 200, cors);
        }

        // DELETE LISTING

        if (editMatch && method === "DELETE") {
          const id = Number(editMatch[1]);

          const linkedOrder = await env.DB.prepare(`
            SELECT id
            FROM orders
            WHERE listing_id = ?
            LIMIT 1
          `).bind(id).first();

          if (linkedOrder) {
            await env.DB.prepare(`
              UPDATE listings
              SET status = 'HIDDEN',
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).bind(id).run();
          } else {
            await env.DB.prepare(`
              DELETE FROM rental_options
              WHERE listing_id = ?
            `).bind(id).run();

            await env.DB.prepare(`
              DELETE FROM listings
              WHERE id = ?
            `).bind(id).run();
          }

          await audit(
            env,
            admin.id,
            "delete_listing",
            String(id)
          );

          return response({
            ok: true,
            deleted: id,
            hidden: Boolean(linkedOrder)
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
      console.error("PRESTIGE WORKER ERROR:", error);

      return response({
        error: "Internal server error",
        details: String(error?.message || error)
      }, 500, cors);
    }
  }
};
