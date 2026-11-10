
import { useEffect, useState } from "react";
import {
  Search, Gift, Gem, Star, User, ShoppingBag,
  ChevronRight, ArrowLeft, ShieldCheck,
  Headphones, Crown, RefreshCw
} from "lucide-react";

declare global {
  interface Window {
    Telegram?: {
      WebApp: {
        initData: string;
        ready: () => void;
        expand: () => void;
        openTelegramLink: (url: string) => void;
      };
    };
  }
}

const API = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
const SUPPORT_USERNAME = "PrestigeMarketSupport";

type Listing = {
  id: number;
  category: string;
  title: string;
  description: string;
  image_url: string | null;
  price_per_day: number;
  min_days: number;
  max_days: number;
};

type Tab = "market" | "nft" | "profile";

type MyListing = Listing & {
  status: string;
};

const categories = [
  { id: "all", label: "Все", icon: ShoppingBag },
  { id: "gifts", label: "NFT Gifts", icon: Gift },
  { id: "usernames", label: "Юзернеймы", icon: Gem },
  { id: "numbers", label: "Номера", icon: Star },
];

function App() {
  const [tab, setTab] = useState<Tab>("market");
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<Listing[]>([]);
  const [selected, setSelected] = useState<Listing | null>(null);
  const [days, setDays] = useState(1);
  const [loading, setLoading] = useState(false);
  const [orders, setOrders] = useState<any[]>([]);
  const [myListings, setMyListings] = useState<MyListing[]>([]);
const [myListingsLoading, setMyListingsLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [ordersLoading, setOrdersLoading] = useState(false);

  const initData = window.Telegram?.WebApp?.initData || "";

  const headers = {
    "Content-Type": "application/json",
    "X-Telegram-Init-Data": initData,
  };

  useEffect(() => {
    window.Telegram?.WebApp?.ready();
    window.Telegram?.WebApp?.expand();
  }, []);

  useEffect(() => {
    loadListings();
  }, [category]);

  async function loadListings() {
    setLoading(true);
    setError("");

    try {
      const params = new URLSearchParams();

      if (category !== "all") {
        params.set("category", category);
      }

      if (search.trim()) {
        params.set("search", search.trim());
      }

      const response = await fetch(
        `${API}/api/listings?${params.toString()}`
      );

      if (!response.ok) {
        throw new Error("Не удалось загрузить каталог");
      }

      const data = await response.json();
      setItems(Array.isArray(data.items) ? data.items : []);
    } catch {
      setItems([]);
      setError("Каталог временно недоступен. Попробуйте обновить страницу.");
    } finally {
      setLoading(false);
    }
  }

  async function loadOrders() {
    if (!initData) {
      setOrders([]);
      setMessage("Откройте приложение через Telegram, чтобы увидеть заказы.");
      return;
    }

    setOrdersLoading(true);

    try {
      const response = await fetch(`${API}/api/orders`, { headers });

      if (!response.ok) {
        throw new Error("Не удалось загрузить заказы");
      }

      const data = await response.json();
      setOrders(Array.isArray(data.items) ? data.items : []);
    } catch {
      setMessage("Не удалось загрузить историю заказов.");
    } finally {
      setOrdersLoading(false);
    }
  }

  async function createRental() {
    if (!selected) return;

    if (!initData) {
      setMessage("Откройте приложение через Telegram, чтобы оформить заявку.");
      return;
    }

    try {
      const response = await fetch(`${API}/api/rentals`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          listing_id: selected.id,
          days,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || "Не удалось создать заявку");
      }

      setMessage(`Заявка №${data.order.id} создана. Ожидайте подтверждения.`);
      setSelected(null);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Ошибка создания заявки"
      );
    }
  }
async function loadMyListings() {
  if (!initData) {
    setMessage("Откройте приложение через Telegram.");
    return;
  }

  setMyListingsLoading(true);

  try {
    const response = await fetch(`${API}/api/my-listings`, { headers });

    if (!response.ok) {
      throw new Error("Не удалось загрузить объявления");
    }

    const data = await response.json();
    setMyListings(Array.isArray(data.items) ? data.items : []);
  } catch {
    setMessage("Не удалось загрузить ваши объявления.");
  } finally {
    setMyListingsLoading(false);
  }
}
  async function createDigitalOrder(kind: string) {
    if (!initData) {
      setMessage("Откройте приложение через Telegram, чтобы оформить заказ.");
      return;
    }

    try {
      const response = await fetch(`${API}/api/orders`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind,
          quantity: 1,
          description: "",
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || "Ошибка создания заказа");
      }

      setMessage(
        `Заявка №${data.order.id} создана. Это ещё не оплата — дождитесь дальнейших инструкций.`
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Не удалось создать заявку."
      );
    }
  }

  function openSupport() {
    window.Telegram?.WebApp?.openTelegramLink(
      `https://t.me/${SUPPORT_USERNAME}`
    );

    if (!window.Telegram?.WebApp) {
      window.open(`https://t.me/${SUPPORT_USERNAME}`, "_blank");
    }
  }

  const filteredItems = items.filter((item) =>
    item.title.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-logo">P</div>
          <div>
            <div className="brand-name">PRESTIGE</div>
            <div className="brand-sub">DIGITAL MARKETPLACE</div>
          </div>
        </div>

        <button className="icon-button" onClick={openSupport}>
          <Headphones size={19} />
        </button>
      </header>

      {selected ? (
        <main className="content">
          <button className="back-button" onClick={() => setSelected(null)}>
            <ArrowLeft size={17} /> Назад в каталог
          </button>

          <div className="detail-image">
            {selected.image_url ? (
              <img src={selected.image_url} alt={selected.title} />
            ) : (
              <Gift size={65} />
            )}
          </div>

          <div className="detail-card">
            <span className="eyebrow">PRESTIGE COLLECTION</span>
            <h1>{selected.title}</h1>
            <p>{selected.description}</p>

            <div className="price-line">
              <span>Стоимость аренды</span>
              <strong>{selected.price_per_day} ⭐ / день</strong>
            </div>

            <div className="days-selector">
              <span>Срок аренды</span>
              <div className="counter">
                <button
                  onClick={() => setDays(Math.max(selected.min_days, days - 1))}
                >
                  −
                </button>
                <strong>{days} дн.</strong>
                <button
                  onClick={() => setDays(Math.min(selected.max_days, days + 1))}
                >
                  +
                </button>
              </div>
            </div>

            <div className="total">
              <span>Итого</span>
              <strong>{selected.price_per_day * days} ⭐</strong>
            </div>

            <button className="primary-button" onClick={createRental}>
              Оставить заявку <ChevronRight size={18} />
            </button>

            <p className="small-note">
              Заявка отправляется на подтверждение. Оплата здесь пока не производится.
            </p>
          </div>
        </main>
      ) : (
        <>
          <main className="content">
            {tab === "market" && (
              <>
                <section className="hero">
                  <div className="hero-content">
                    <span className="eyebrow">EXCLUSIVE DIGITAL GOODS</span>
                    <h1>
                      Твой мир
                      <br />
                      <span>цифровой роскоши</span>
                    </h1>
                    <p>
                      Коллекционные подарки, аренда NFT и цифровые услуги.
                    </p>
                    <button
                      className="hero-button"
                      onClick={() => setTab("nft")}
                    >
                      Открыть каталог <ChevronRight size={17} />
                    </button>
                  </div>
                  <div className="hero-decoration">
                    <Crown size={76} strokeWidth={1} />
                  </div>
                </section>

                <div className="section-heading">
                  <div>
                    <span className="eyebrow">DISCOVER</span>
                    <h2>Каталог</h2>
                  </div>
                  <span className="live-label">
                    <span /> MARKET
                  </span>
                </div>

                <div className="category-list">
                  {categories.map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.id}
                        className={category === item.id ? "category active" : "category"}
                        onClick={() => {
                          setCategory(item.id);
                          setTab("nft");
                        }}
                      >
                        <Icon size={17} />
                        {item.label}
                      </button>
                    );
                  })}
                </div>

                <div className="section-heading">
                  <div>
                    <span className="eyebrow">HANDPICKED</span>
                    <h2>Популярное</h2>
                  </div>
                  <button className="text-button" onClick={() => setTab("nft")}>
                    Все товары <ChevronRight size={15} />
                  </button>
                </div>

                {loading ? (
                  <div className="empty-state">Загрузка каталога...</div>
                ) : (
                  <div className="product-grid">
                    {items.slice(0, 2).map((item) => (
                      <ProductCard
                        key={item.id}
                        item={item}
                        onClick={() => {
                          setSelected(item);
                          setDays(item.min_days);
                        }}
                      />
                    ))}
                  </div>
                )}

                {!loading && items.length === 0 && (
                  <div className="empty-state">
                    <Gift size={36} />
                    <strong>{error ? "Каталог недоступен" : "Пока нет объявлений"}</strong>
                    <span>{error || "Новые предложения появятся здесь."}</span>
                    <button className="text-button" onClick={loadListings}>
                      <RefreshCw size={15} /> Обновить
                    </button>
                  </div>
                )}

                <section className="service-grid">
                  <button onClick={() => createDigitalOrder("stars")}>
                    <Star size={23} />
                    <strong>Telegram Stars</strong>
                    <span>Оставить заявку</span>
                  </button>

                  <button onClick={() => createDigitalOrder("premium")}>
                    <Gem size={23} />
                    <strong>Telegram Premium</strong>
                    <span>Оставить заявку</span>
                  </button>
                </section>
              </>
            )}

            {tab === "nft" && (
              <>
                <div className="section-heading">
                  <div>
                    <span className="eyebrow">EXPLORE COLLECTIONS</span>
                    <h2>Маркет</h2>
                  </div>
                </div>

                <div className="search-box">
                  <Search size={18} />
                  <input
                    placeholder="Поиск товаров..."
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") loadListings();
                    }}
                  />
                  <button onClick={loadListings}>Найти</button>
                </div>

                <div className="category-list">
                  {categories.map((item) => (
                    <button
                      key={item.id}
                      className={category === item.id ? "category active" : "category"}
                      onClick={() => setCategory(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>

                {loading ? (
                  <div className="empty-state">Загрузка каталога...</div>
                ) : filteredItems.length === 0 ? (
                  <div className="empty-state">
                    <Gift size={36} />
                    <strong>{error ? "Каталог недоступен" : "Пока нет объявлений"}</strong>
                    <span>{error || "Новые предложения появятся здесь."}</span>
                    <button className="text-button" onClick={loadListings}>
                      <RefreshCw size={15} /> Обновить
                    </button>
                  </div>
                ) : (
                  <div className="product-grid">
                    {filteredItems.map((item) => (
                      <ProductCard
                        key={item.id}
                        item={item}
                        onClick={() => {
                          setSelected(item);
                          setDays(item.min_days);
                        }}
                      />
                    ))}
                  </div>
                )}

                <button className="secondary-button" onClick={() => createDigitalOrder("stars")}>
                  ⭐ Заказать Telegram Stars
                </button>

                <button className="secondary-button" onClick={() => createDigitalOrder("premium")}>
                  💎 Заказать Premium
                </button>
              </>
            )}

            {tab === "profile" && (
              <>
                <div className="section-heading">
                  <div>
                    <span className="eyebrow">YOUR ACCOUNT</span>
                    <h2>Профиль</h2>
                  </div>
                </div>

                <div className="profile-card">
                  <div className="profile-avatar">
                    <User size={30} />
                  </div>
                  <div>
                    <strong>PRESTIGE MEMBER</strong>
                    <span>Telegram account</span>
                  </div>
                  <ShieldCheck size={21} />
                </div>

                <div className="profile-menu">
                  <button onClick={loadOrders}>
                    <ShoppingBag size={19} />
                    Мои заказы
                    <ChevronRight size={17} />
                  </button>
                  
<button onClick={loadMyListings}>
  <Gift size={19} />
  Мои объявления
  <ChevronRight size={17} />
</button>
                  <button onClick={openSupport}>
                    <Headphones size={19} />
                    Поддержка
                    <ChevronRight size={17} />
                  </button>

                  <button onClick={() => setMessage("Правила сервиса будут опубликованы отдельно.")}>
                    <ShieldCheck size={19} />
                    Правила сервиса
                    <ChevronRight size={17} />
                  </button>
                </div>

                <div className="orders-list">
                  <h3>История заказов</h3>
                  {ordersLoading ? (
                    <p>Загрузка заказов...</p>
                  ) : orders.length === 0 ? (
                    <p>Заказов пока нет.</p>
                  ) : (
                    orders.map((order) => (
                      <div className="order-row" key={order.id}>
                        <div>
                          <strong>№{order.id}</strong>
                          <span>{order.kind}</span>
                        </div>
                        <span>{order.status}</span>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}

            {message && (
              <div className="notice">
                {message}
                <button onClick={() => setMessage("")}>×</button>
              </div>
            )}
          </main>

          <nav className="bottom-nav">
            <button
              className={tab === "market" ? "nav-item active" : "nav-item"}
              onClick={() => setTab("market")}
            >
              <ShoppingBag size={20} />
              <span>Главная</span>
            </button>

            <button
              className={tab === "nft" ? "nav-item active" : "nav-item"}
              onClick={() => setTab("nft")}
            >
              <Gift size={20} />
              <span>Маркет</span>
            </button>

            <button
              className={tab === "profile" ? "nav-item active" : "nav-item"}
              onClick={() => {
                setTab("profile");
                loadOrders();
              }}
            >
              <User size={20} />
              <span>Профиль</span>
            </button>
          </nav>
        </>
      )}
    </div>
  );
}

function ProductCard({
  item,
  onClick,
}: {
  item: Listing;
  onClick: () => void;
}) {
  return (
    <button className="product-card" onClick={onClick}>
      <div className="product-image">
        {item.image_url ? (
          <img src={item.image_url} alt={item.title} />
        ) : (
          <Gift size={43} />
        )}
        <span className="product-tag">NFT</span>
      </div>

      <div className="product-info">
        <span>{item.category}</span>
        <strong>{item.title}</strong>
        <div className="product-price">
          {item.price_per_day} ⭐ <small>/ день</small>
        </div>
      </div>
    </button>
  );
}
export default App;
