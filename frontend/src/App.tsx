
import { useEffect, useState } from "react";
import {
  Search, Gift, Gem, User, ShoppingBag, ChevronRight,
  ArrowLeft, ShieldCheck, Headphones, Crown, RefreshCw,
  Plus, Trash2, Pencil, Eye, EyeOff
} from "lucide-react";

const API = (
  import.meta.env.VITE_API_URL || "https://prestige.rtmzakarin.workers.dev"
).replace(/\/$/, "");

const SUPPORT_USERNAME = "PrestigeMarketSupport";

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

type RentalOption = {
  id?: number;
  duration_days: number;
  price: number;
  is_active?: number;
};

type Listing = {
  id: number;
  title: string;
  description: string;
  category: string;
  image_url: string | null;
  price: number;
  status: string;
  rental_options: RentalOption[];
};

type FormOption = {
  duration_days: string;
  price: string;
};

function App() {
  const initData = window.Telegram?.WebApp?.initData || "";
const initData = window.Telegram?.WebApp?.initData || "";

console.log("WEBAPP:", !!window.Telegram?.WebApp);
console.log("INITDATA LENGTH:", window.Telegram?.WebApp?.initData?.length || 0);
console.log("PLATFORM:", window.Telegram?.WebApp?.platform);

  const headers = {
    "Content-Type": "application/json",
    "X-Telegram-Init-Data": initData
  };

  const [tab, setTab] = useState("market");
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<Listing[]>([]);
  const [selected, setSelected] = useState<Listing | null>(null);
  const [selectedOption, setSelectedOption] = useState<RentalOption | null>(null);

  const [isAdmin, setIsAdmin] = useState(false);
  const [debugInfo, setDebugInfo] = useState("Проверка ещё не выполнена");
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminListings, setAdminListings] = useState<Listing[]>([]);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [giftCategory, setGiftCategory] = useState("gifts");

  const [options, setOptions] = useState<FormOption[]>([
    { duration_days: "3", price: "100" },
    { duration_days: "7", price: "200" },
    { duration_days: "30", price: "500" }
  ]);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    window.Telegram?.WebApp?.ready();
    window.Telegram?.WebApp?.expand();
    loadListings();
    checkAdmin();
  }, []);

  async function checkAdmin() {
  setDebugInfo("Проверяем Telegram...");

  if (!window.Telegram?.WebApp) {
    setDebugInfo("Ошибка: Telegram WebApp не обнаружен");
    return;
  }

  if (!initData) {
    setDebugInfo("Ошибка: Telegram не передал initData");
    return;
  }

  setDebugInfo("Telegram обнаружен. Проверяем права...");

  try {
    const response = await fetch(`${API}/api/admin/listings`, {
      headers
    });

    if (response.ok) {
      const data = await response.json();
      setIsAdmin(true);
      setAdminListings(data.listings || []);
      setDebugInfo("Успешно: администратор подтверждён");
    } else {
      setDebugInfo(`Ошибка авторизации: HTTP ${response.status}`);
    }
  } catch {
    setDebugInfo("Ошибка соединения с сервером");
  }
}
  async function loadListings() {
    setLoading(true);
    setError("");

    try {
      const response = await fetch(`${API}/api/listings`);

      if (!response.ok) {
        throw new Error("Catalog unavailable");
      }

      const data = await response.json();
      setItems(Array.isArray(data.listings) ? data.listings : []);
    } catch {
      setItems([]);
      setError("Не удалось загрузить каталог. Попробуйте обновить страницу.");
    } finally {
      setLoading(false);
    }
  }

  async function loadAdminListings() {
    if (!initData) {
      setMessage("Откройте приложение через Telegram.");
      return;
    }

    try {
      const response = await fetch(`${API}/api/admin/listings`, {
        headers
      });

      if (!response.ok) {
        throw new Error("Нет доступа администратора");
      }

      const data = await response.json();
      setAdminListings(data.listings || []);
      setIsAdmin(true);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Ошибка загрузки");
    }
  }

  function resetForm() {
    setEditingId(null);
    setTitle("");
    setDescription("");
    setImageUrl("");
    setGiftCategory("gifts");
    setOptions([
      { duration_days: "3", price: "100" },
      { duration_days: "7", price: "200" },
      { duration_days: "30", price: "500" }
    ]);
  }

  function editListing(item: Listing) {
    setEditingId(item.id);
    setTitle(item.title);
    setDescription(item.description || "");
    setImageUrl(item.image_url || "");
    setGiftCategory(item.category || "gifts");

    setOptions(
      (item.rental_options || []).map(option => ({
        duration_days: String(option.duration_days),
        price: String(option.price)
      }))
    );

    if (!item.rental_options?.length) {
      setOptions([{ duration_days: "7", price: String(item.price || 0) }]);
    }

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function addOption() {
    setOptions([
      ...options,
      { duration_days: "14", price: "300" }
    ]);
  }

  function updateOption(index: number, field: keyof FormOption, value: string) {
    setOptions(current =>
      current.map((option, i) =>
        i === index ? { ...option, [field]: value } : option
      )
    );
  }

  function removeOption(index: number) {
    setOptions(current => current.filter((_, i) => i !== index));
  }

  async function saveListing() {
    if (!initData || !isAdmin) {
      setMessage("Нет доступа администратора.");
      return;
    }

    if (!title.trim()) {
      setMessage("Укажи название подарка.");
      return;
    }

    const preparedOptions = options.map(option => ({
      duration_days: Number(option.duration_days),
      price: Number(option.price)
    }));

    if (
      !preparedOptions.length ||
      preparedOptions.some(option =>
        !Number.isInteger(option.duration_days) ||
        option.duration_days < 1 ||
        !Number.isFinite(option.price) ||
        option.price < 0
      )
    ) {
      setMessage("Проверь сроки и цены аренды.");
      return;
    }

    setSaving(true);
    setMessage("");

    try {
      const body = {
        title: title.trim(),
        description: description.trim(),
        category: giftCategory,
        image_url: imageUrl.trim(),
        rental_options: preparedOptions
      };

      const url = editingId
        ? `${API}/api/admin/listings/${editingId}`
        : `${API}/api/admin/listings`;

      const response = await fetch(url, {
        method: editingId ? "PATCH" : "POST",
        headers,
        body: JSON.stringify(body)
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Не удалось сохранить подарок");
      }

      setMessage(editingId ? "Подарок обновлён!" : "Подарок добавлен!");
      resetForm();
      await loadAdminListings();
      await loadListings();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Ошибка сохранения");
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus(item: Listing) {
    const newStatus = item.status === "APPROVED" ? "HIDDEN" : "APPROVED";

    try {
      const response = await fetch(
        `${API}/api/admin/listings/${item.id}`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({ status: newStatus })
        }
      );

      if (!response.ok) throw new Error("Не удалось изменить статус");

      await loadAdminListings();
      await loadListings();
      setMessage(newStatus === "APPROVED" ? "Подарок опубликован" : "Подарок скрыт");
    } catch {
      setMessage("Ошибка изменения статуса");
    }
  }

  async function deleteListing(id: number) {
    if (!window.confirm("Удалить этот подарок?")) return;

    try {
      const response = await fetch(`${API}/api/admin/listings/${id}`, {
        method: "DELETE",
        headers
      });

      if (!response.ok) throw new Error();

      setMessage("Подарок удалён.");
      if (editingId === id) resetForm();

      await loadAdminListings();
      await loadListings();
    } catch {
      setMessage("Не удалось удалить подарок.");
    }
  }

  function openSupport() {
    const url = `https://t.me/${SUPPORT_USERNAME}`;

    if (window.Telegram?.WebApp) {
      window.Telegram.WebApp.openTelegramLink(url);
    } else {
      window.open(url, "_blank");
    }
  }

  const filteredItems = items.filter(item => {
    const matchesSearch = item.title.toLowerCase().includes(search.toLowerCase());
    const matchesCategory = category === "all" || item.category === category;
    return matchesSearch && matchesCategory;
  });

  const totalPrice = selectedOption?.price || 0;

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
      <div className="content" style={{ paddingTop: 8 }}>
  <div className="notice">{debugInfo}</div>
</div>

      {isAdmin && (
        <div className="content">
          <button
            className="secondary-button"
            onClick={async () => {
              const next = !adminOpen;
              setAdminOpen(next);
              setSelected(null);
              if (next) await loadAdminListings();
            }}
          >
            <ShieldCheck size={18} />
            {adminOpen ? "Закрыть админ-панель" : "Админ-панель"}
          </button>
        </div>
      )}

      {adminOpen && isAdmin ? (
        <main className="content">
          <div className="section-heading">
            <div>
              <span className="eyebrow">CONTROL CENTER</span>
              <h2>Админ-панель</h2>
            </div>
            <ShieldCheck size={25} />
          </div>

          <div className="detail-card">
            <h3>{editingId ? "Редактировать подарок" : "Добавить подарок"}</h3>

            <label>Название подарка</label>
            <input
              className="admin-input"
              placeholder="Например: Precious Peach"
              value={title}
              onChange={e => setTitle(e.target.value)}
            />

            <label>Описание</label>
            <textarea
              className="admin-input"
              placeholder="Описание подарка..."
              value={description}
              onChange={e => setDescription(e.target.value)}
            />

            <label>Ссылка на изображение</label>
            <input
              className="admin-input"
              placeholder="https://..."
              value={imageUrl}
              onChange={e => setImageUrl(e.target.value)}
            />

            {imageUrl && (
              <div className="detail-image">
                <img src={imageUrl} alt="Предпросмотр подарка" />
              </div>
            )}

            <label>Категория</label>
            <select
              className="admin-input"
              value={giftCategory}
              onChange={e => setGiftCategory(e.target.value)}
            >
              <option value="gifts">NFT Gifts</option>
              <option value="usernames">Юзернеймы</option>
              <option value="numbers">Номера</option>
            </select>

            <div className="section-heading">
              <h3>Сроки и цены аренды</h3>
              <button className="text-button" onClick={addOption}>
                <Plus size={16} /> Добавить срок
              </button>
            </div>

            {options.map((option, index) => (
              <div className="detail-card" key={index}>
                <label>Срок аренды в днях</label>
                <input
                  className="admin-input"
                  type="number"
                  min="1"
                  value={option.duration_days}
                  onChange={e =>
                    updateOption(index, "duration_days", e.target.value)
                  }
                />

                <label>Цена за весь срок</label>
                <input
                  className="admin-input"
                  type="number"
                  min="0"
                  value={option.price}
                  onChange={e =>
                    updateOption(index, "price", e.target.value)
                  }
                />

                {options.length > 1 && (
                  <button
                    className="text-button"
                    onClick={() => removeOption(index)}
                  >
                    <Trash2 size={15} /> Удалить срок
                  </button>
                )}
              </div>
            ))}

            <button
              className="primary-button"
              disabled={saving}
              onClick={saveListing}
            >
              {saving ? "Сохранение..." : editingId ? "Сохранить изменения" : "Добавить подарок"}
              <ChevronRight size={18} />
            </button>

            {editingId && (
              <button className="secondary-button" onClick={resetForm}>
                Отменить редактирование
              </button>
            )}
          </div>

          <div className="section-heading">
            <div>
              <span className="eyebrow">INVENTORY</span>
              <h2>Все подарки</h2>
            </div>
            <button className="text-button" onClick={loadAdminListings}>
              <RefreshCw size={15} />
            </button>
          </div>

          {adminListings.map(item => (
            <div className="detail-card" key={item.id}>
              <div className="product-info">
                {item.image_url && (
                  <img
                    src={item.image_url}
                    alt={item.title}
                    style={{
                      width: "100%",
                      maxHeight: 150,
                      objectFit: "contain",
                      borderRadius: 12
                    }}
                  />
                )}
                <strong>{item.title}</strong>
                <span>{item.status === "APPROVED" ? "Опубликован" : "Скрыт"}</span>
                <span>
                  {(item.rental_options || []).map(o =>
                    `${o.duration_days} дн. — ${o.price}`
                  ).join(" / ")}
                </span>
              </div>

              <div className="category-list">
                <button className="secondary-button" onClick={() => editListing(item)}>
                  <Pencil size={16} /> Изменить
                </button>
                <button className="secondary-button" onClick={() => changeStatus(item)}>
                  {item.status === "APPROVED" ? <EyeOff size={16} /> : <Eye size={16} />}
                  {item.status === "APPROVED" ? "Скрыть" : "Опубликовать"}
                </button>
                <button className="secondary-button" onClick={() => deleteListing(item.id)}>
                  <Trash2 size={16} /> Удалить
                </button>
              </div>
            </div>
          ))}

          {adminListings.length === 0 && (
            <div className="empty-state">Подарков пока нет. Добавь первый выше.</div>
          )}

          <button className="secondary-button" onClick={() => setAdminOpen(false)}>
            Вернуться в магазин
          </button>

          {message && (
            <div style={{color: "white", padding: 12, background: "#333"}}>
  ДИАГНОСТИКА: {debugInfo}
</div>
              
              
          )}
        </main>
      ) : selected ? (
        <main className="content">
          <button className="back-button" onClick={() => setSelected(null)}>
            <ArrowLeft size={17} /> Назад в каталог
          </button>

          <div className="detail-image">
            {selected.image_url
              ? <img src={selected.image_url} alt={selected.title} />
              : <Gift size={65} />}
          </div>

          <div className="detail-card">
            <span className="eyebrow">PRESTIGE COLLECTION</span>
            <h1>{selected.title}</h1>
            <p>{selected.description}</p>

            <label>Выбери срок аренды</label>

            {(selected.rental_options || [])
              .filter(option => option.is_active !== 0)
              .map(option => (
                <button
                  key={option.id || option.duration_days}
                  className="secondary-button"
                  onClick={() => setSelectedOption(option)}
                >
                  {option.duration_days} дней — {option.price}
                  {selectedOption?.duration_days === option.duration_days ? " ✓" : ""}
                </button>
              ))}

            <div className="total">
              <span>Стоимость аренды</span>
              <strong>{totalPrice}</strong>
            </div>

            <button
              className="primary-button"
              disabled={!selectedOption}
              onClick={() => {
                setMessage("Заявка на аренду будет подключена следующим этапом.");
              }}
            >
              Оставить заявку <ChevronRight size={18} />
            </button>

            <p className="small-note">
              Оплата и подтверждение аренды согласовываются с администрацией.
            </p>
          </div>

          {message && <div className="notice">{message}</div>}
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
                    <p>Коллекционные подарки, аренда NFT и цифровые услуги.</p>
                    <button className="hero-button" onClick={() => setTab("nft")}>
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
                </div>

                <div className="product-grid">
                  {items.slice(0, 2).map(item => (
                    <ProductCard key={item.id} item={item} onClick={() => {
                      setSelected(item);
                      setSelectedOption(null);
                    }} />
                  ))}
                </div>

                {items.length === 0 && !loading && (
                  <div className="empty-state">
                    <Gift size={36} />
                    <strong>{error ? "Каталог недоступен" : "Пока нет подарков"}</strong>
                    <span>{error || "Новые предложения появятся здесь."}</span>
                    <button className="text-button" onClick={loadListings}>
                      <RefreshCw size={15} /> Обновить
                    </button>
                  </div>
                )}
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
                    placeholder="Поиск подарков..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                  />
                </div>

                <div className="category-list">
                  {[
                    ["all", "Все"],
                    ["gifts", "NFT Gifts"],
                    ["usernames", "Юзернеймы"],
                    ["numbers", "Номера"]
                  ].map(([id, label]) => (
                    <button
                      key={id}
                      className={category === id ? "category active" : "category"}
                      onClick={() => setCategory(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {loading ? (
                  <div className="empty-state">Загрузка...</div>
                ) : (
                  <div className="product-grid">
                    {filteredItems.map(item => (
                      <ProductCard key={item.id} item={item} onClick={() => {
                        setSelected(item);
                        setSelectedOption(null);
                      }} />
                    ))}
                  </div>
                )}

                {!loading && filteredItems.length === 0 && (
                  <div className="empty-state">Подарки не найдены.</div>
                )}
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
              onClick={() => setTab("profile")}
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
  onClick
}: {
  item: Listing;
  onClick: () => void;
}) {
  const prices = (item.rental_options || [])
    .filter(option => option.is_active !== 0)
    .map(option => option.price);

  const minPrice = prices.length ? Math.min(...prices) : item.price;

  return (
    <button className="product-card" onClick={onClick}>
      <div className="product-image">
        {item.image_url
          ? <img src={item.image_url} alt={item.title} />
          : <Gift size={43} />}
        <span className="product-tag">NFT</span>
      </div>

      <div className="product-info">
        <span>{item.category}</span>
        <strong>{item.title}</strong>
        <div className="product-price">
          От {minPrice} <small>/ аренда</small>
        </div>
      </div>
    </button>
  );
}

export default App;
