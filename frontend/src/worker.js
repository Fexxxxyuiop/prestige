
const ALLOWED_ORIGINS = [
  "https://fexxxxyuiop.github.io",
  "https://web.telegram.org",
  "https://t.me"
];

const CATEGORIES = {
  gifts: "/v1/rent/gifts/",
  numbers: "/v1/rent/numbers/",
  usernames: "/v1/rent/usernames/"
};

function cors(request) {
  const origin = request.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin)
      ? origin
      : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, X-Telegram-Init-Data, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function response(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors(request),
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function number(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function adminIds(env) {
  return String(env.ADMIN_IDS || "")
    .split(/[ ,;]+/)
    .map(x => x.trim())
    .filter(Boolean);
}

async function hmac(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      new TextEncoder().encode(message)
    )
  );
}

function toHex(bytes) {
  return [...bytes].map(x => x.toString(16).padStart(2, "0")).join("");
}

async function telegramUser(request, env) {
  if (!env.BOT_TOKEN) return null;

  const initData =
    request.headers.get("X-Telegram-Init-Data") || "";

  if (!initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");

  if (!hash) return null;

  params.delete("hash");

  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => key + "=" + value)
    .join("\n");

  const secret = await hmac(
    new TextEncoder().encode("WebAppData"),
    env.BOT_TOKEN
  );

  const calculated = toHex(await hmac(secret, dataCheck));

  if (calculated !== hash) return null;

  const authDate = Number(params.get("auth_date") || 0);

  if (!authDate || Date.now() / 1000 - authDate > 86400) {
    return null;
  }

  try {
    return JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
}

async function adminUser(request, env) {
  const user = await telegramUser(request, env);

  if (!user || !adminIds(env).includes(String(user.id))) {
    return null;
  }

  return user;
}

async function ensureTables(env) {
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT UNIQUE NOT NULL,
        username TEXT,
        first_name TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `),

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT NOT NULL,
        listing_id INTEGER,
        duration_days INTEGER,
        currency TEXT,
        amount REAL,
        status TEXT DEFAULT 'PENDING',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT
      )
    `),

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS marketapp_imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        external_id TEXT NOT NULL,
        listing_id INTEGER NOT NULL,
        source_price_raw TEXT,
        source_price_ton REAL,
        raw_json TEXT,
        last_seen TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(category, external_id)
      )
    `),

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS marketapp_sync_state (
        category TEXT PRIMARY KEY,
        cursor TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `),

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS stars_prices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        amount INTEGER NOT NULL,
        price REAL NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USDT',
        is_active INTEGER DEFAULT 1
      )
    `),

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS stars_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT NOT NULL,
        username TEXT,
        stars_amount INTEGER NOT NULL,
        price REAL NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USDT',
        status TEXT DEFAULT 'PENDING',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `)
  ]);

  const columns = await env.DB.prepare(
    "PRAGMA table_info(rental_options)"
  ).all();

  if (!(columns.results || []).some(x => x.name === "currency")) {
    await env.DB.prepare(
      "ALTER TABLE rental_options ADD COLUMN currency TEXT NOT NULL DEFAULT 'TON'"
    ).run();
  }
}

async function audit(env, admin, action, details = {}) {
  await env.DB.prepare(`
    INSERT INTO admin_audit
      (admin_telegram_id, action, details)
    VALUES (?, ?, ?)
  `).bind(
    String(admin.id),
    action,
    JSON.stringify(details)
  ).run();
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
    ORDER BY duration_days
  `).bind(id).all();

  return {
    ...listing,
    rental_options: options.results || []
  };
}

function externalId(item) {
  return String(
    item.nft_address ||
    item.address ||
    item.username ||
    item.phone_number ||
    item.number ||
    item.id ||
    ""
  );
}

function imageUrl(item) {
  const candidates = [
    item.image_url,
    item.image,
    item.photo_url,
    item.preview_url,
    item.thumbnail_url,
    item.media?.url,
    item.preview?.url
  ];

  return candidates.find(
    x => typeof x === "string" && /^https:\/\//i.test(x)
  ) || null;
}

function daysFromSeconds(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0
    ? Math.ceil(n / 86400)
    : fallback;
}

async function marketRequest(env, category, cursor) {
  if (!env.MARKETAPP_API_BASE || !env.MARKETAPP_API_TOKEN) {
    throw new Error(
      "Нужны переменные MARKETAPP_API_BASE и MARKETAPP_API_TOKEN"
    );
  }

  const base = env.MARKETAPP_API_BASE.replace(/\/+$/, "");
  const url = new URL(base + CATEGORIES[category]);

  url.searchParams.set("limit", "100");
  if (cursor) url.searchParams.set("cursor", cursor);

  const result = await fetch(url, {
    headers: {
      "Authorization": env.MARKETAPP_API_TOKEN,
      "Accept": "application/json"
    }
  });

  const text = await result.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("MarketApp вернул неправильный ответ");
  }

  if (!result.ok) {
    throw new Error("MarketApp HTTP " + result.status);
  }

  return data;
}

async function importItem(env, category, item) {
  const id = externalId(item);
  if (!id) return "skipped";

  const rawPrice = String(item.price_per_day ?? "");
  const priceTon = number(rawPrice) / 1000000000;

  const minDays = daysFromSeconds(item.min_duration, 1);
  const maxDays = daysFromSeconds(item.max_duration, 180);

  const validPrice =
    priceTon > 0 &&
    Number.isFinite(priceTon) &&
    maxDays >= minDays;

  const title = String(
    item.nft_name ||
    item.title ||
    item.username ||
    item.phone_number ||
    item.number ||
    category + " " + id
  ).slice(0, 240);

  const description = [
    item.description || "",
    Array.isArray(item.attributes)
      ? item.attributes.map(x =>
          x.trait_type + ": " + x.value
        ).join(" • ")
      : ""
  ].filter(Boolean).join("\n").slice(0, 4000);

  const existing = await env.DB.prepare(`
    SELECT listing_id
    FROM marketapp_imports
    WHERE category = ? AND external_id = ?
  `).bind(category, id).first();

  let listingId;

  if (existing) {
    listingId = existing.listing_id;

    await env.DB.prepare(`
      UPDATE listings
      SET title = ?,
          description = ?,
          category = ?,
          image_url = ?,
          rental_period = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      title,
      description,
      category,
      imageUrl(item),
      minDays + "-" + maxDays + " days",
      listingId
    ).run();
  } else {
    const result = await env.DB.prepare(`
      INSERT INTO listings
        (title, description, category, image_url, price,
         rental_period, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'marketapp')
    `).bind(
      title,
      description,
      category,
      imageUrl(item),
      validPrice ? priceTon : 0,
      minDays + "-" + maxDays + " days",
      validPrice ? "APPROVED" : "PENDING"
    ).run();

    listingId = result.meta.last_row_id;
  }

  if (validPrice) {
    const durations = [...new Set(
      [minDays, 7, 30, 90, maxDays]
        .filter(x => x >= minDays && x <= maxDays)
    )];

    await env.DB.prepare(`
      DELETE FROM rental_options
      WHERE listing_id = ? AND currency = 'TON'
    `).bind(listingId).run();

    for (const days of durations) {
      await env.DB.prepare(`
        INSERT INTO rental_options
          (listing_id, duration_days, price, is_active, currency)
        VALUES (?, ?, ?, 1, 'TON')
      `).bind(
        listingId,
        days,
        Number((priceTon * days).toFixed(9))
      ).run();
    }
  }

  await env.DB.prepare(`
    INSERT INTO marketapp_imports
      (category, external_id, listing_id, source_price_raw,
       source_price_ton, raw_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(category, external_id)
    DO UPDATE SET
      listing_id = excluded.listing_id,
      source_price_raw = excluded.source_price_raw,
      source_price_ton = excluded.source_price_ton,
      raw_json = excluded.raw_json,
      last_seen = CURRENT_TIMESTAMP
  `).bind(
    category,
    id,
    listingId,
    rawPrice,
    validPrice ? priceTon : null,
    JSON.stringify(item)
  ).run();

  return existing ? "updated" : "inserted";
}

async function syncMarketApp(env) {
  const summary = {};

  for (const category of Object.keys(CATEGORIES)) {
    const state = await env.DB.prepare(
      "SELECT cursor FROM marketapp_sync_state WHERE category = ?"
    ).bind(category).first();

    let cursor = state?.cursor || null;
    let pages = 0;
    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    while (pages < 3) {
      const data = await marketRequest(env, category, cursor);
      const items = Array.isArray(data.items)
        ? data.items
        : Array.isArray(data.data?.items)
          ? data.data.items
          : [];

      for (const item of items) {
        const result = await importItem(env, category, item);
        if (result === "inserted") inserted++;
        else if (result === "updated") updated++;
        else skipped++;
      }

      pages++;
      cursor =
        data.next_cursor ||
        data.cursor ||
        data.pagination?.next_cursor ||
        null;

      if (!cursor) break;
    }

    await env.DB.prepare(`
      INSERT INTO marketapp_sync_state (category, cursor)
      VALUES (?, ?)
      ON CONFLICT(category)
      DO UPDATE SET cursor = excluded.cursor,
        updated_at = CURRENT_TIMESTAMP
    `).bind(category, cursor).run();

    summary[category] = {
      pages,
      inserted,
      updated,
      skipped,
      has_more: Boolean(cursor)
    };
  }

  return summary;
}

async function notifyAdmins(env, message) {
  if (!env.BOT_TOKEN) return;

  await Promise.all(adminIds(env).map(async id => {
    try {
      await fetch(
        "https://api.telegram.org/bot" +
          env.BOT_TOKEN +
          "/sendMessage",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: id,
            text: message
          })
        }
      );
    } catch {}
  }));
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: cors(request)
    });
  }

  if (path === "/health") {
    return response(request, {
      ok: true,
      service: "Prestige Market",
      status: "online"
    });
  }

  if (!env.DB) {
    return response(request, {
      ok: false,
      error: "Не подключена D1 binding DB"
    }, 500);
  }

  await ensureTables(env);

  if (path === "/api/catalog" && method === "GET") {
    return response(request, {
      ok: true,
      categories: [
        { id: "gifts", name: "NFT Gifts", icon: "🎁" },
        { id: "numbers", name: "Numbers", icon: "📱" },
        { id: "usernames", name: "Usernames", icon: "👤" },
        { id: "stars", name: "Telegram Stars", icon: "⭐" },
        { id: "premium", name: "Telegram Premium", icon: "💎" }
      ]
    });
  }

  if (path === "/api/listings" && method === "GET") {
    const category = url.searchParams.get("category");
    let sql = "SELECT id FROM listings WHERE status = 'APPROVED'";
    const args = [];

    if (category) {
      sql += " AND category = ?";
      args.push(category);
    }

    sql += " ORDER BY id DESC LIMIT 500";

    const rows = await env.DB.prepare(sql).bind(...args).all();
    const listings = [];

    for (const row of rows.results || []) {
      listings.push(await getListing(env, row.id));
    }

    return response(request, { ok: true, listings });
  }

  const publicItem = path.match(/^\/api\/listings\/(\d+)$/);

  if (publicItem && method === "GET") {
    const item = await getListing(env, Number(publicItem[1]));

    if (!item || item.status !== "APPROVED") {
      return response(request, {
        ok: false,
        error: "Товар не найден"
      }, 404);
    }

    return response(request, { ok: true, listing: item });
  }

  if (path === "/api/orders" && method === "POST") {
    const user = await telegramUser(request, env);

    if (!user) {
      return response(request, {
        ok: false,
        error: "Telegram authorization required"
      }, 401);
    }

    const body = await request.json().catch(() => ({}));
    const listingId = Number(body.listing_id || body.listingId);
    const days = Number(body.duration_days || body.durationDays);
    const currency = String(body.currency || "TON").toUpperCase();

    if (!listingId || !days || !["TON", "USDT", "RUB"].includes(currency)) {
      return response(request, {
        ok: false,
        error: "Некорректные параметры заказа"
      }, 400);
    }

    const listing = await env.DB.prepare(`
      SELECT id, title FROM listings
      WHERE id = ? AND status = 'APPROVED'
    `).bind(listingId).first();

    if (!listing) {
      return response(request, {
        ok: false,
        error: "Товар недоступен"
      }, 404);
    }

    const option = await env.DB.prepare(`
      SELECT price FROM rental_options
      WHERE listing_id = ? AND duration_days = ?
        AND currency = ? AND is_active = 1
    `).bind(listingId, days, currency).first();

    if (!option) {
      return response(request, {
        ok: false,
        error: "Вариант аренды не найден"
      }, 400);
    }

    await env.DB.prepare(`
      INSERT INTO users (telegram_id, username, first_name)
      VALUES (?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name
    `).bind(
      String(user.id),
      user.username || null,
      user.first_name || null
    ).run();

    const result = await env.DB.prepare(`
      INSERT INTO orders
        (telegram_id, listing_id, duration_days, currency, amount)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      String(user.id),
      listingId,
      days,
      currency,
      option.price
    ).run();

    await notifyAdmins(
      env,
      "Новый заказ #" + result.meta.last_row_id +
      "\n" + listing.title +
      "\nСрок: " + days + " дней" +
      "\nСумма: " + option.price + " " + currency
    );

    return response(request, {
      ok: true,
      order_id: result.meta.last_row_id,
      amount: option.price,
      currency
    });
  }

  if (path === "/api/orders" && method === "GET") {
    const user = await telegramUser(request, env);
    if (!user) {
      return response(request, {
        ok: false,
        error: "Telegram authorization required"
      }, 401);
    }

    const rows = await env.DB.prepare(`
      SELECT * FROM orders
      WHERE telegram_id = ?
      ORDER BY id DESC LIMIT 100
    `).bind(String(user.id)).all();

    return response(request, {
      ok: true,
      orders: rows.results || []
    });
  }

  if (path.startsWith("/api/admin/")) {
    const admin = await adminUser(request, env);

    if (!admin) {
      return response(request, {
        ok: false,
        error: "Admin access denied"
      }, 403);
    }

    if (path === "/api/admin/marketapp/sync" && method === "POST") {
      try {
        const result = await syncMarketApp(env);
        await audit(env, admin, "marketapp_sync", result);
        return response(request, { ok: true, result });
      } catch (error) {
        return response(request, {
          ok: false,
          error: error.message
        }, 502);
      }
    }

    if (path === "/api/admin/listings" && method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT id FROM listings ORDER BY id DESC LIMIT 500"
      ).all();

      const listings = [];

      for (const row of rows.results || []) {
        listings.push(await getListing(env, row.id));
      }

      return response(request, { ok: true, listings });
    }

    if (path === "/api/admin/listings" && method === "POST") {
      const b = await request.json().catch(() => ({}));

      if (!b.title || !b.category) {
        return response(request, {
          ok: false,
          error: "Нужны title и category"
        }, 400);
      }

      const result = await env.DB.prepare(`
        INSERT INTO listings
          (title, description, category, image_url, price,
           rental_period, status, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        String(b.title),
        b.description || "",
        String(b.category),
        b.image_url || null,
        number(b.price),
        b.rental_period || null,
        b.status || "PENDING",
        String(admin.id)
      ).run();

      const id = result.meta.last_row_id;

      for (const opt of Array.isArray(b.rental_options) ? b.rental_options : []) {
        const days = Number(opt.duration_days);
        const price = number(opt.price, -1);
        const currency = String(opt.currency || "TON").toUpperCase();

        if (days > 0 && price >= 0 &&
            ["TON", "USDT", "RUB"].includes(currency)) {
          await env.DB.prepare(`
            INSERT INTO rental_options
              (listing_id, duration_days, price, is_active, currency)
            VALUES (?, ?, ?, ?, ?)
          `).bind(
            id,
            days,
            price,
            opt.is_active === false ? 0 : 1,
            currency
          ).run();
        }
      }

      await audit(env, admin, "listing_create", { id });

      return response(request, {
        ok: true,
        listing: await getListing(env, id)
      }, 201);
    }

    const listingRoute = path.match(/^\/api\/admin\/listings\/(\d+)$/);

    if (listingRoute && method === "PATCH") {
      const id = Number(listingRoute[1]);
      const b = await request.json().catch(() => ({}));

      const allowed = [
        "title",
        "description",
        "category",
        "image_url",
        "price",
        "rental_period",
        "status"
      ];

      const fields = allowed.filter(key =>
        Object.prototype.hasOwnProperty.call(b, key)
      );

      if (fields.length) {
        const sql =
          "UPDATE listings SET " +
          fields.map(key => key + " = ?").join(", ") +
          ", updated_at = CURRENT_TIMESTAMP WHERE id = ?";

        await env.DB.prepare(sql)
          .bind(...fields.map(key => b[key]), id)
          .run();
      }

      if (Array.isArray(b.rental_options)) {
        await env.DB.prepare(
          "DELETE FROM rental_options WHERE listing_id = ?"
        ).bind(id).run();

        for (const opt of b.rental_options) {
          const days = Number(opt.duration_days);
          const price = number(opt.price, -1);
          const currency = String(opt.currency || "TON").toUpperCase();

          if (days > 0 && price >= 0 &&
              ["TON", "USDT", "RUB"].includes(currency)) {
            await env.DB.prepare(`
              INSERT INTO rental_options
                (listing_id, duration_days, price, is_active, currency)
              VALUES (?, ?, ?, ?, ?)
            `).bind(
              id,
              days,
              price,
              opt.is_active === false ? 0 : 1,
              currency
            ).run();
          }
        }
      }

      await audit(env, admin, "listing_update", { id, fields });

      return response(request, {
        ok: true,
        listing: await getListing(env, id)
      });
    }

    if (listingRoute && method === "DELETE") {
      const id = Number(listingRoute[1]);

      await env.DB.batch([
        env.DB.prepare(
          "DELETE FROM rental_options WHERE listing_id = ?"
        ).bind(id),
        env.DB.prepare(
          "DELETE FROM listings WHERE id = ?"
        ).bind(id)
      ]);

      await audit(env, admin, "listing_delete", { id });

      return response(request, { ok: true });
    }

    if (path === "/api/admin/orders" && method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT * FROM orders ORDER BY id DESC LIMIT 300"
      ).all();

      return response(request, {
        ok: true,
        orders: rows.results || []
      });
    }

    const orderRoute = path.match(/^\/api\/admin\/orders\/(\d+)$/);

    if (orderRoute && method === "PATCH") {
      const b = await request.json().catch(() => ({}));
      const status = String(b.status || "").toUpperCase();

      if (![
        "PENDING", "PAID", "COMPLETED", "CANCELLED", "REJECTED"
      ].includes(status)) {
        return response(request, {
          ok: false,
          error: "Недопустимый статус"
        }, 400);
      }

      await env.DB.prepare(`
        UPDATE orders
        SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(status, Number(orderRoute[1])).run();

      await audit(env, admin, "order_status", {
        id: Number(orderRoute[1]),
        status
      });

      return response(request, { ok: true });
    }

    if (path === "/api/admin/stars/prices" && method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT * FROM stars_prices ORDER BY amount"
      ).all();

      return response(request, {
        ok: true,
        prices: rows.results || []
      });
    }

    if (path === "/api/admin/stars/prices" && method === "POST") {
      const b = await request.json().catch(() => ({}));
      const amount = Number(b.amount);
      const price = number(b.price, -1);
      const currency = String(b.currency || "USDT").toUpperCase();

      if (amount <= 0 || price < 0 ||
          !["TON", "USDT", "RUB"].includes(currency)) {
        return response(request, {
          ok: false,
          error: "Некорректная цена"
        }, 400);
      }

      const result = await env.DB.prepare(`
        INSERT INTO stars_prices (amount, price, currency, is_active)
        VALUES (?, ?, ?, 1)
      `).bind(amount, price, currency).run();

      await audit(env, admin, "stars_price_create", {
        id: result.meta.last_row_id
      });

      return response(request, {
        ok: true,
        id: result.meta.last_row_id
      });
    }

    if (path === "/api/admin/stars/orders" && method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT * FROM stars_orders ORDER BY id DESC LIMIT 300"
      ).all();

      return response(request, {
        ok: true,
        orders: rows.results || []
      });
    }

    return response(request, {
      ok: false,
      error: "Admin route not found"
    }, 404);
  }

  if (path === "/api/stars/prices" && method === "GET") {
    const rows = await env.DB.prepare(`
      SELECT * FROM stars_prices
      WHERE is_active = 1 ORDER BY amount
    `).all();

    return response(request, {
      ok: true,
      prices: rows.results || []
    });
  }

  if (path === "/api/stars/orders" && method === "POST") {
    const user = await telegramUser(request, env);

    if (!user) {
      return response(request, {
        ok: false,
        error: "Telegram authorization required"
      }, 401);
    }

    const b = await request.json().catch(() => ({}));
    const amount = Number(b.amount);

    const price = await env.DB.prepare(`
      SELECT * FROM stars_prices
      WHERE amount = ? AND is_active = 1
    `).bind(amount).first();

    if (!price) {
      return response(request, {
        ok: false,
        error: "Тариф не найден"
      }, 404);
    }

    const result = await env.DB.prepare(`
      INSERT INTO stars_orders
        (telegram_id, username, stars_amount, price, currency)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      String(user.id),
      user.username || null,
      amount,
      price.price,
      price.currency
    ).run();

    await notifyAdmins(
      env,
      "Новый заказ Stars #" + result.meta.last_row_id +
      "\nКоличество: " + amount
    );

    return response(request, {
      ok: true,
      order_id: result.meta.last_row_id,
      price: price.price,
      currency: price.currency
    });
  }

  if (path === "/api/stars/orders" && method === "GET") {
    const user = await telegramUser(request, env);

    if (!user) {
      return response(request, {
        ok: false,
        error: "Telegram authorization required"
      }, 401);
    }

    const rows = await env.DB.prepare(`
      SELECT * FROM stars_orders
      WHERE telegram_id = ?
      ORDER BY id DESC LIMIT 100
    `).bind(String(user.id)).all();

    return response(request, {
      ok: true,
      orders: rows.results || []
    });
  }

  return response(request, {
    ok: false,
    error: "Not found"
  }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (error) {
      return response(request, {
        ok: false,
        error: error?.message || "Internal error"
      }, 500);
    }
  }
};
