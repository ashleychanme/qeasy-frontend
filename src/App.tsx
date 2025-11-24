// src/App.tsx
// Qeasy メイン画面 完成版（カテゴリ自動判定＋Amazonリンク版）
//
// - Keepa ASIN CSV 読込
// - Amazon情報・Qoo10既存チェック・出品API呼び出し
// - Prime / 出品者1人除外 / NGワード / 価格ルール / カテゴリ自動割当
// - 出品結果をページ内ULで表示
// - 設定 & 商品一覧: localStorage + /settings + /items 同期
// - 「最新情報に更新」ボタンで /items/refresh と連携（定期バッチ結果をUIに反映）

import React, {
  useState,
  useEffect,
  useMemo,
  type ChangeEvent,
} from "react";
import "./index.css";

import {
  fetchAmazonBulk,
  checkQoo10Existing,
  createQoo10Listings,
  fetchSettings,
  saveSettings,
  fetchItems,
  saveItems,
  refreshItems,
  type AmazonItemInfo,
  type Qoo10ListingPayload,
  type CreateListingResult,
  type QeasyItem,
} from "./api/qeasy";

import { classifyQoo10Category } from "./qoo10Category";

type Page = "list" | "settings" | "profile";

type PriceRule = {
  min: number;
  max?: number;
  multiply: number;
  plus: number;
};

type CategoryMap = Record<string, number>;

type Product = {
  id: number;
  asin: string;
  name: string;
  jan?: string;
  qoo10Id?: string;
  mainImage: string;
  images?: string[];
  amazonPrice: number;
  inStock?: boolean;
  updatedAt: string;
};

type SettingsState = {
  primeOnly: boolean;
  primeShipDaysMax: number;
  maxStockPerItem: number;

  shippingCode: string;
  rules: PriceRule[];

  noListASINs: string[];
  noListWords: string[];
  nameEraseWords: string[];
  keepASINsOnDelete: string[];

  categoryMap: CategoryMap;
  autoCategoryEnabled: boolean;

  notifyOnSuccess: boolean;
  notifyOnError: boolean;
  autoApplyTemplate: boolean;
};

type ListingStatus = "success" | "exists" | "forbidden" | "error";

type ListingResultItem = {
  asin: string;
  name: string;
  status: ListingStatus;
  message: string;
  hitWords?: string[];
  qoo10ItemCode?: string;
};

/* ========== 定数 ========== */

const SETTINGS_KEY = "qeasy-settings-v3";
const PRODUCTS_KEY = "qeasy-products-v3";

const DEFAULT_SETTINGS: SettingsState = {
  primeOnly: true,
  primeShipDaysMax: 3,
  maxStockPerItem: 2,
  shippingCode: "645035",
  rules: [
    { min: 1, max: 3000, multiply: 1.2, plus: 400 },
    { min: 3001, max: 6000, multiply: 1.2, plus: 500 },
    { min: 6001, multiply: 1.2, plus: 600 },
  ],
  noListASINs: [],
  noListWords: [],
  nameEraseWords: ["Amazon.co.jp 限定", "発送"],
  keepASINsOnDelete: [],
  categoryMap: {
    ヘナ: 120000,
    シャンプー: 120000,
    サプリ: 130000,
  },
  autoCategoryEnabled: true,
  notifyOnSuccess: true,
  notifyOnError: true,
  autoApplyTemplate: true,
};

const SEED_PRODUCTS: Product[] = [];

/* ========== Util ========== */

const formatYen = (v: number): string =>
  "¥" + Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const applyRule = (price: number, rules: PriceRule[]): number => {
  if (!price || price <= 0) return 0;
  const r = rules.find((rr) =>
    rr.max != null ? price >= rr.min && price <= rr.max : price >= rr.min
  );
  const result = r ? price * r.multiply + r.plus : price;
  return Math.max(1, Math.round(result));
};

const stripWords = (title: string, words: string[]): string => {
  let t = title || "";
  for (const w of words) {
    if (!w) continue;
    t = t.split(w).join("");
  }
  return t.replace(/\s+/g, " ").trim();
};

// Keepa ASIN CSV 解析（ヘッダASIN / ""付き / 1列対応）
const parseAsinCsv = (text: string): string[] => {
  const rawLines = text.split(/\r?\n/);
  let lines = rawLines.map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];

  if (lines[0].charCodeAt(0) === 0xfeff) {
    lines[0] = lines[0].slice(1);
  }

  const headerCells = lines[0]
    .split(/[,;\t]/)
    .map((c) =>
      c
        .replace(/^["']+|["']+$/g, "")
        .trim()
        .toLowerCase()
    );
  const asinIndex = headerCells.indexOf("asin");
  const startRow = asinIndex !== -1 ? 1 : 0;

  const asins: string[] = [];

  for (let i = startRow; i < lines.length; i++) {
    const row = lines[i];
    if (!row) continue;

    const cells = row.split(/[,;\t]/);
    const idx = asinIndex !== -1 ? asinIndex : 0;
    if (idx >= cells.length) continue;

    const raw = cells[idx].trim();
    const cleaned = raw.replace(/^["']+|["']+$/g, "").trim();
    if (!cleaned) continue;

    if (/^[A-Z0-9]{10}$/i.test(cleaned)) {
      asins.push(cleaned.toUpperCase());
    }
  }

  return Array.from(new Set(asins));
};

/* ========== カテゴリ自動割当 ========== */
/**
 * 手動マップ → 自動推定（classifyQoo10Category）の順でカテゴリを決定。
 * 戻り値は Qoo10 に渡す SecondSubCat の数値。
 */
const chooseCategory = (
  info: AmazonItemInfo | undefined,
  p: Product,
  settings: SettingsState
): number | undefined => {
  const rawTitle = info?.title || p.name || "";
  const titleLower = rawTitle.toLowerCase();

  // 1. 手動カテゴリマップ（キーワード → カテゴリNo）
  for (const [key, cat] of Object.entries(settings.categoryMap)) {
    if (!key) continue;
    if (titleLower.includes(key.toLowerCase())) {
      return cat;
    }
  }

  // 2. 自動判定を使わない設定ならここまで
  if (!settings.autoCategoryEnabled) {
    return undefined;
  }

  // 3. ビューティ系細分けを含む自動推定
  const decision = classifyQoo10Category(rawTitle);

  if (!decision) return undefined;

  if (decision.main === "120000") {
    // ビューティは beautySecondSubCat を SecondSubCat として使う
    const sub = decision.beautySecondSubCat ?? "120000012";
    return Number(sub);
  }

  // サプリ／美容家電／日用品などは main をそのまま SecondSubCat として扱う
  return Number(decision.main);
};

/* ========== QeasyItem → Product マッピング ========== */

const mapItemsToProducts = (items: QeasyItem[]): Product[] =>
  items
    .filter((r) => r.asin)
    .map((r, idx) => ({
      id: idx + 1,
      asin: r.asin,
      name: r.name || r.asin,
      jan: r.jan,
      qoo10Id: r.qoo10Id,
      mainImage:
        r.mainImage ||
        "https://via.placeholder.com/120x120.png?text=No+Image",
      images: r.mainImage ? [r.mainImage] : [],
      amazonPrice: r.amazonPrice || 0,
      inStock: r.inStock,
      updatedAt: r.updatedAt || "",
    }));

/* ========== TagEditor ========== */

type TagEditorProps = {
  title: string;
  tags: string[];
  onChange: (tags: string[]) => void;
};

const TagEditor: React.FC<TagEditorProps> = ({
  title,
  tags,
  onChange,
}) => {
  const [value, setValue] = useState("");
  const [bulk, setBulk] = useState("");
  const [showBulk, setShowBulk] = useState(false);

  const add = () => {
    const t = value.trim();
    if (!t || tags.includes(t)) return;
    onChange([t, ...tags]);
    setValue("");
  };

  const addBulk = () => {
    const list = bulk
      .split(/[\s,\n、，]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (!list.length) return;
    const set = new Set(tags);
    list.forEach((t) => set.add(t));
    onChange(Array.from(set));
    setBulk("");
    setShowBulk(false);
  };

  const remove = (t: string) => {
    onChange(tags.filter((x) => x !== t));
  };

  return (
    <div className="settings-card">
      <div className="settings-subtitle">{title}</div>
      <div className="settings-btn-row">
        <input
          className="settings-input"
          placeholder="単体入力して Enter / 登録"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button className="btn btn-green" onClick={add}>
          登録
        </button>
        <button
          className="btn btn-pink"
          onClick={() => setShowBulk((s) => !s)}
        >
          一括登録
        </button>
      </div>

      {showBulk && (
        <>
          <textarea
            className="settings-input"
            style={{ marginTop: 4, height: 72 }}
            placeholder="改行・スペース・カンマ区切りで複数入力"
            value={bulk}
            onChange={(e) => setBulk(e.target.value)}
          />
          <div style={{ marginTop: 4, textAlign: "right" }}>
            <button className="btn btn-green" onClick={addBulk}>
              追加
            </button>
          </div>
        </>
      )}

      <div className="pill-list" style={{ marginTop: 8 }}>
        {tags.length === 0 && (
          <div className="note">登録された項目はありません。</div>
        )}
        {tags.map((t) => (
          <div key={t} className="pill">
            {t}
            <span className="pill-remove" onClick={() => remove(t)}>
              ×
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

/* ========== 出品結果 UL表示 ========== */

type ListingResultInlineProps = {
  results: ListingResultItem[] | null;
};

const ListingResultInline: React.FC<ListingResultInlineProps> = ({
  results,
}) => {
  if (!results || results.length === 0) return null;

  const exists = results.filter((r) => r.status === "exists");
  const forbidden = results.filter((r) => r.status === "forbidden");
  const error = results.filter((r) => r.status === "error");
  const success = results.filter((r) => r.status === "success");

  return (
    <div className="result-box">
      <div className="result-title">直近の出品結果</div>

      {exists.length > 0 && (
        <>
          <div className="result-heading result-heading-blue">
            既にQoo10に存在: {exists.length}件
          </div>
          <ul className="result-list">
            {exists.map((r) => (
              <li key={r.asin}>
                {r.asin} -{" "}
                {r.message ||
                  "Qoo10に既に同一ASINの商品があります。"}
              </li>
            ))}
          </ul>
        </>
      )}

      {forbidden.length > 0 && (
        <>
          <div className="result-heading result-heading-red">
            出品不可・禁止条件: {forbidden.length}件
          </div>
          <ul className="result-list">
            {forbidden.map((r) => (
              <li key={r.asin}>
                {r.asin} -{" "}
                {r.message ||
                  "出品不可ASINまたは禁止ワードに該当するため除外しました。"}
                {r.hitWords && r.hitWords.length > 0 && (
                  <>（禁止ワード: {r.hitWords.join(", ")}）</>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {error.length > 0 && (
        <>
          <div className="result-heading result-heading-red">
            エラー: {error.length}件
          </div>
          <ul className="result-list">
            {error.map((r, i) => (
              <li key={r.asin + ":" + i}>
                {r.asin} -{" "}
                {r.message ||
                  "出品処理中にエラーが発生しました。"}
              </li>
            ))}
          </ul>
        </>
      )}

      {success.length > 0 && (
        <>
          <div className="result-heading result-heading-green">
            出品成功: {success.length}件
          </div>
          <ul className="result-list">
            {success.map((r) => (
              <li key={r.asin}>
                {r.asin} -{" "}
                {r.qoo10ItemCode
                  ? `Qoo10商品コード: ${r.qoo10ItemCode}`
                  : r.message ||
                    "出品登録が完了しました。"}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
};

/* ========== メインコンポーネント ========== */

const App: React.FC = () => {
  const [page, setPage] = useState<Page>("list");

  const [settings, setSettings] = useState<SettingsState>(() => {
    try {
      const saved = localStorage.getItem(SETTINGS_KEY);
      return saved
        ? (JSON.parse(saved) as SettingsState)
        : DEFAULT_SETTINGS;
    } catch {
      return DEFAULT_SETTINGS;
    }
  });

  const [products, setProducts] = useState<Product[]>(() => {
    try {
      const saved = localStorage.getItem(PRODUCTS_KEY);
      return saved
        ? (JSON.parse(saved) as Product[])
        : SEED_PRODUCTS;
    } catch {
      return SEED_PRODUCTS;
    }
  });

  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [listingResults, setListingResults] =
    useState<ListingResultItem[] | null>(null);

  const [newCatKey, setNewCatKey] = useState("");
  const [newCatVal, setNewCatVal] = useState("");

  /* ----- 設定: /settings があれば同期 ----- */

  useEffect(() => {
    (async () => {
      const remote = await fetchSettings();
      if (remote) {
        setSettings((cur) => ({
          ...cur,
          ...remote,
        }));
      }
    })();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {}
    saveSettings(settings).catch(() => {});
  }, [settings]);

  /* ----- 商品一覧: /items があれば同期 ----- */

  useEffect(() => {
    (async () => {
      const remote = await fetchItems();
      if (remote && remote.length) {
        setProducts(mapItemsToProducts(remote));
      }
    })();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(PRODUCTS_KEY, JSON.stringify(products));
    } catch {}
    const payload = products.map((p) => ({
      asin: p.asin,
      name: p.name,
      jan: p.jan,
      qoo10Id: p.qoo10Id,
      mainImage: p.mainImage,
      amazonPrice: p.amazonPrice,
      inStock: p.inStock,
      updatedAt: p.updatedAt,
    }));
    saveItems(payload).catch(() => {});
  }, [products]);

  /* ----- 最新情報リフレッシュ（Step4用） ----- */

  const handleRefreshItems = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refreshItems().catch(() => {});
      const remote = await fetchItems();
      if (remote && remote.length) {
        setProducts(mapItemsToProducts(remote));
        setListingResults(null);
      }
    } catch (e) {
      console.error(e);
      alert(
        "最新情報の取得に失敗しました。server.mjs / qeasy-api を確認してください。"
      );
    } finally {
      setRefreshing(false);
    }
  };

  /* ----- 絞り込み ----- */

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) =>
      (
        p.name +
        " " +
        p.asin +
        " " +
        (p.jan || "") +
        " " +
        (p.qoo10Id || "")
      )
        .toLowerCase()
        .includes(q)
    );
  }, [products, search]);

  /* ----- 選択操作 ----- */

  const toggleSelect = (id: number, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      checked ? next.add(id) : next.delete(id);
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());
  const selectVisible = () =>
    setSelected(new Set(filteredProducts.map((p) => p.id)));

  const deleteSelected = () => {
    if (!selected.size) return;
    if (!window.confirm("選択した商品を一覧から削除しますか？")) return;
    setProducts((prev) =>
      prev.filter(
        (p) =>
          !selected.has(p.id) ||
          settings.keepASINsOnDelete.includes(p.asin)
      )
    );
    clearSelection();
  };

  const deleteAll = () => {
    if (!products.length) return;
    if (
      !window.confirm(
        "全ての商品を一覧から削除しますか？（削除対象外ASINは残ります）"
      )
    )
      return;
    setProducts((prev) =>
      prev.filter((p) => settings.keepASINsOnDelete.includes(p.asin))
    );
    clearSelection();
  };

  /* ----- CSV取込 ----- */

  const handleCsvUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    const text = await file.text();
    const asins = parseAsinCsv(text);
    if (!asins.length) {
      alert(
        'ASINが読み取れませんでした。\n1列目が "ASIN" または ASINのみのCSVか確認してください。'
      );
      return;
    }

    try {
      const infos = await fetchAmazonBulk(asins);
      const now = new Date().toISOString().replace("T", " ").slice(0, 19);

      setProducts((prev) => {
        const used = new Set(prev.map((p) => p.asin));
        const next = [...prev];
        let idBase =
          next.length > 0 ? Math.max(...next.map((p) => p.id)) + 1 : 1;

        for (const info of infos) {
          const asin = info.asin?.toUpperCase();
          if (!asin || used.has(asin)) continue;

          next.push({
            id: idBase++,
            asin,
            name: info.title || asin,
            mainImage:
              info.image ||
              "https://via.placeholder.com/120x120.png?text=No+Image",
            images: info.image ? [info.image] : [],
            amazonPrice: info.price || 0,
            inStock: !!info.price,
            updatedAt: now,
          });
          used.add(asin);
        }

        return next;
      });
    } catch (err) {
      console.error(err);
      alert(
        "CSV取込中にエラーが発生しました。server.mjs / qeasy-api が起動しているか確認してください。"
      );
    }
  };

  /* ----- 出品処理 ----- */

  const runListing = async () => {
    if (loading) return;
    setLoading(true);
    setListingResults(null);

    try {
      const targets =
        selected.size > 0
          ? products.filter((p) => selected.has(p.id))
          : filteredProducts;

      if (!targets.length) {
        setListingResults([]);
        return;
      }

      const asins = targets.map((p) => p.asin);

      const [amazonInfos, existingAsins] = await Promise.all([
        fetchAmazonBulk(asins),
        checkQoo10Existing(asins),
      ]);

      const infoMap = new Map<string, AmazonItemInfo>();
      amazonInfos.forEach((i) => i.asin && infoMap.set(i.asin, i));
      const existsSet = new Set(existingAsins);

      const results: ListingResultItem[] = [];
      const payloads: Qoo10ListingPayload[] = [];

      for (const p of targets) {
        const info = infoMap.get(p.asin);

        if (!info || !info.price) {
          results.push({
            asin: p.asin,
            name: p.name,
            status: "error",
            message: "Amazon価格が取得できませんでした。",
          });
          continue;
        }

        // Prime条件
        if (settings.primeOnly) {
          if (
            info.isPrime === false ||
            (info.shipDays != null &&
              info.shipDays > settings.primeShipDaysMax)
          ) {
            results.push({
              asin: p.asin,
              name: p.name,
              status: "forbidden",
              message: `Prime条件を満たさないため除外（出荷まで ${
                info.shipDays ?? "-"
              }日）`,
            });
            continue;
          }
        }

        // 出品者1人以下は除外（固定ルール）
        if (info.sellerCount != null && info.sellerCount <= 1) {
          results.push({
            asin: p.asin,
            name: p.name,
            status: "forbidden",
            message: `出品者が1人のみのため除外しました。（${info.sellerCount}人）`,
          });
          continue;
        }

        if (settings.noListASINs.includes(p.asin)) {
          results.push({
            asin: p.asin,
            name: p.name,
            status: "forbidden",
            message: "出品不可ASINに登録されています。",
          });
          continue;
        }

        const hitWords = settings.noListWords.filter(
          (w) => w && p.name.includes(w)
        );
        if (hitWords.length) {
          results.push({
            asin: p.asin,
            name: p.name,
            status: "forbidden",
            message: `禁止ワード(${hitWords.join(
              ", "
            )})が含まれているため除外しました。`,
            hitWords,
          });
          continue;
        }

        if (existsSet.has(p.asin)) {
          results.push({
            asin: p.asin,
            name: p.name,
            status: "exists",
            message: "Qoo10に同一ASINの商品が既に存在します。",
          });
          continue;
        }

        const title = stripWords(
          info.title || p.name,
          settings.nameEraseWords
        );
        const price = applyRule(info.price, settings.rules);
        if (!price || price <= 0) {
          results.push({
            asin: p.asin,
            name: p.name,
            status: "error",
            message: "価格ルール適用後の価格が不正のため除外しました。",
          });
          continue;
        }

        const categoryNo = chooseCategory(info, p, settings);
        const stock =
          settings.maxStockPerItem > 0
            ? settings.maxStockPerItem
            : 1;

        payloads.push({
          asin: p.asin,
          price,
          shippingCode: settings.shippingCode,
          title,
          imageUrl: info.image,
          categoryNo,
          stock,
          jan: p.jan, // JAN をそのままAPIに渡す
        });
      }

      if (!payloads.length) {
        setListingResults(results);
        clearSelection();
        return;
      }

      const created: CreateListingResult[] =
        await createQoo10Listings(payloads);

      for (const r of created) {
        const baseName =
          targets.find((p) => p.asin === r.asin)?.name || r.asin;

        if (r.ok) {
          results.push({
            asin: r.asin,
            name: baseName,
            status: "success",
            message: r.message || "出品登録が完了しました。",
            qoo10ItemCode: r.qoo10ItemCode,
          });
        } else {
          results.push({
            asin: r.asin,
            name: baseName,
            status: "error",
            message:
              r.message ||
              (r.code
                ? `出品APIエラー (code: ${r.code})`
                : "出品APIからエラーが返されました。"),
          });
        }
      }

      setListingResults(results);
      clearSelection();
    } catch (e: any) {
      console.error(e);
      setListingResults([
        {
          asin: "-",
          name: "",
          status: "error",
          message:
            e?.message ||
            "出品処理中に予期せぬエラーが発生しました。",
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  /* ========== JSX ========== */

  return (
    <div className="page">
      <header>
        <div className="logo">Qeasy</div>
        <nav className="nav">
          <button
            className={page === "list" ? "nav-link active" : "nav-link"}
            onClick={() => setPage("list")}
          >
            商品一覧
          </button>
          <button
            className={page === "settings" ? "nav-link active" : "nav-link"}
            onClick={() => setPage("settings")}
          >
            出品・設定
          </button>
          <button
            className={page === "profile" ? "nav-link active" : "nav-link"}
            onClick={() => setPage("profile")}
          >
            登録情報
          </button>
          <div className="nav-avatar" />
        </nav>
      </header>

      <main>
        {/* ===== 商品一覧 ===== */}
        <section className={`page-section ${page === "list" ? "active" : ""}`}>
          <h1 className="page-title">出品商品一覧</h1>

          <div className="green-bar-wrap">
            <div className="green-bar">商品一覧</div>
          </div>

          <div className="search-info">
            商品名・ASIN・JAN・商品コード(Qoo10)で検索できます ／
            KeepaのASIN CSVを読み込み可能 ／
            「最新情報に更新」で定期バッチ結果を反映
          </div>

          <div className="search-row">
            <input
              className="search-input"
              placeholder="例: B07MNQ8M4G / 4524989000838 / 1172139715"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button className="btn btn-green">検索</button>
            <button
              className="btn btn-pink"
              onClick={() => setSearch("")}
            >
              キャンセル
            </button>

            <label className="btn btn-blue">
              CSVから追加
              <input
                type="file"
                accept=".csv"
                style={{ display: "none" }}
                onChange={handleCsvUpload}
              />
            </label>

            <button
              className="btn btn-blue"
              onClick={handleRefreshItems}
              disabled={refreshing}
            >
              {refreshing ? "最新情報取得中..." : "最新情報に更新"}
            </button>
          </div>

          <div className="delete-row">
            <button className="btn btn-blue" onClick={selectVisible}>
              表示中を全選択
            </button>
            <button className="btn btn-blue" onClick={clearSelection}>
              選択解除
            </button>
            <button className="btn btn-red" onClick={deleteSelected}>
              選択削除
            </button>
            <button className="btn btn-red" onClick={deleteAll}>
              全部削除
            </button>
            <button
              className="btn btn-green"
              onClick={runListing}
              disabled={loading}
            >
              {loading ? "出品処理中..." : "選択商品を出品"}
            </button>
          </div>

          <ListingResultInline results={listingResults} />

          <div className="table-card">
            <table aria-label="出品商品一覧">
              <thead>
                <tr>
                  <th></th>
                  <th>メイン画像</th>
                  <th>商品名</th>
                  <th>ASIN</th>
                  <th>JAN</th>
                  <th>商品コード(Qoo10)</th>
                  <th>Amazon価格</th>
                  <th>Qoo10価格(試算)</th>
                  <th>更新日時</th>
                </tr>
              </thead>
              <tbody>
                {filteredProducts.map((p) => {
                  const preview =
                    p.inStock === false
                      ? 0
                      : applyRule(p.amazonPrice, settings.rules);
                  const amazonUrl = `https://www.amazon.co.jp/dp/${p.asin}`;
                  return (
                    <tr key={p.id}>
                      <td className="checkbox-cell">
                        <input
                          type="checkbox"
                          checked={selected.has(p.id)}
                          onChange={(e) =>
                            toggleSelect(p.id, e.target.checked)
                          }
                        />
                      </td>
                      <td className="cell-center">
                        <a
                          href={amazonUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <div className="thumb-wrap">
                            <img
                              className="thumb-main"
                              src={p.mainImage}
                              alt={p.name}
                            />
                            {p.images?.slice(0, 2).map((u, idx) => (
                              <img
                                key={idx}
                                className="thumb-sub"
                                src={u}
                                alt={p.name}
                              />
                            ))}
                          </div>
                        </a>
                      </td>
                      <td className="cell-name">
                        <a
                          href={amazonUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="link-amazon"
                        >
                          {p.name}
                        </a>
                      </td>
                      <td className="cell-center">{p.asin}</td>
                      <td className="cell-center">{p.jan || "-"}</td>
                      <td className="cell-center">{p.qoo10Id || "-"}</td>
                      <td className="cell-right">
                        {p.amazonPrice ? formatYen(p.amazonPrice) : "-"}
                      </td>
                      <td className="cell-right">
                        {p.inStock === false
                          ? "在庫なし"
                          : preview
                          ? formatYen(preview)
                          : "-"}
                      </td>
                      <td className="cell-center">{p.updatedAt}</td>
                    </tr>
                  );
                })}
                {filteredProducts.length === 0 && (
                  <tr>
                    <td colSpan={9} className="cell-center">
                      該当する商品がありません。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* ===== 出品・設定 ===== */}
        <section
          className={`page-section ${
            page === "settings" ? "active" : ""
          }`}
        >
          <h1 className="page-title">出品・設定</h1>

          {/* 基本設定 */}
          <div className="section-title">基本設定</div>
          <div className="settings-grid">
            <div className="settings-card">
              <div className="settings-label">出品者数条件</div>
              <div className="note">
                Amazon の出品者が<strong>1人のみ</strong>の商品は、
                知的財産権リスク回避のため自動的に除外します。
                （このルールは固定で変更できません）
              </div>
            </div>
            <div className="settings-card">
              <div className="settings-label">送料コード</div>
              <input
                className="settings-input"
                value={settings.shippingCode}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    shippingCode: e.target.value.replace(/[^0-9]/g, ""),
                  }))
                }
              />
            </div>
          </div>

          {/* Prime / 在庫 */}
          <div className="section-title">Prime・在庫条件</div>
          <div className="settings-card">
            <div className="toggle-row">
              <div className="toggle-label">Prime商品のみ出品</div>
              <input
                type="checkbox"
                className="toggle-input"
                checked={settings.primeOnly}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    primeOnly: e.target.checked,
                  }))
                }
              />
            </div>
            <div className="toggle-row">
              <div className="toggle-label">Prime判定 最大日数</div>
              <input
                type="number"
                className="settings-input"
                min={1}
                value={settings.primeShipDaysMax}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    primeShipDaysMax: Number(e.target.value) || 3,
                  }))
                }
              />
            </div>
            <div className="toggle-row">
              <div className="toggle-label">1商品あたり在庫上限</div>
              <input
                type="number"
                className="settings-input"
                min={0}
                value={settings.maxStockPerItem}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    maxStockPerItem: Number(e.target.value) || 0,
                  }))
                }
              />
            </div>
          </div>

          {/* 価格設定 */}
          <div className="section-title">価格設定（Amazon → Qoo10）</div>
          <div className="settings-card">
            <div className="settings-label">価格レンジごとの係数・加算</div>
            {settings.rules.map((r, i) => (
              <div key={i} style={{ marginTop: 6 }}>
                <div className="settings-label">
                  {r.min}円〜{r.max ?? "上限なし"}円
                </div>
                <div className="settings-btn-row">
                  <span>×</span>
                  <input
                    className="settings-input"
                    style={{ width: 80 }}
                    value={r.multiply}
                    onChange={(e) =>
                      setSettings((s) => {
                        const rules = [...s.rules];
                        rules[i] = {
                          ...rules[i],
                          multiply:
                            Number(
                              e.target.value.replace(/[^0-9.]/g, "")
                            ) || 1,
                        };
                        return { ...s, rules };
                      })
                    }
                  />
                  <span>＋</span>
                  <input
                    className="settings-input"
                    style={{ width: 80 }}
                    value={r.plus}
                    onChange={(e) =>
                      setSettings((s) => {
                        const rules = [...s.rules];
                        rules[i] = {
                          ...rules[i],
                          plus:
                            Number(
                              e.target.value.replace(/[^0-9]/g, "")
                            ) || 0,
                        };
                        return { ...s, rules };
                      })
                    }
                  />
                  <span>円</span>
                </div>
              </div>
            ))}
          </div>

          {/* カテゴリ自動割当 */}
          <div className="section-title">カテゴリ自動割当</div>
          <div className="settings-card">
            <div className="toggle-row">
              <div className="toggle-label">
                自動カテゴリ推定を有効にする
                <div className="note">
                  手動マップにヒットしない場合、タイトルから自動推定します。
                </div>
              </div>
              <input
                type="checkbox"
                className="toggle-input"
                checked={settings.autoCategoryEnabled}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    autoCategoryEnabled: e.target.checked,
                  }))
                }
              />
            </div>

            <div className="pill-list">
              {Object.keys(settings.categoryMap).length === 0 && (
                <div className="note">
                  手動カテゴリマップは未登録です。
                </div>
              )}
              {Object.entries(settings.categoryMap).map(([k, v]) => (
                <div key={k} className="pill">
                  {k} → {v}
                  <span
                    className="pill-remove"
                    onClick={() =>
                      setSettings((s) => {
                        const map = { ...s.categoryMap };
                        delete map[k];
                        return { ...s, categoryMap: map };
                      })
                    }
                  >
                    ×
                  </span>
                </div>
              ))}
            </div>

            <div className="settings-btn-row">
              <input
                className="settings-input"
                placeholder="キーワード（例: ヘナ）"
                value={newCatKey}
                onChange={(e) => setNewCatKey(e.target.value)}
              />
              <input
                className="settings-input"
                placeholder="カテゴリNo（例: 120000）"
                value={newCatVal}
                onChange={(e) => setNewCatVal(e.target.value)}
              />
              <button
                className="btn btn-green"
                onClick={() => {
                  const k = newCatKey.trim();
                  const v = Number(newCatVal.trim());
                  if (!k || !v) return;
                  setSettings((s) => ({
                    ...s,
                    categoryMap: { ...s.categoryMap, [k]: v },
                  }));
                  setNewCatKey("");
                  setNewCatVal("");
                }}
              >
                追加
              </button>
            </div>
          </div>

          {/* 出品制御 */}
          <div className="section-title">出品制御ルール</div>
          <div className="settings-grid">
            <TagEditor
              title="出品不可ASIN"
              tags={settings.noListASINs}
              onChange={(tags) =>
                setSettings((s) => ({ ...s, noListASINs: tags }))
              }
            />
            <TagEditor
              title="出品不可ワード"
              tags={settings.noListWords}
              onChange={(tags) =>
                setSettings((s) => ({ ...s, noListWords: tags }))
              }
            />
            <TagEditor
              title="商品名削除ワード"
              tags={settings.nameEraseWords}
              onChange={(tags) =>
                setSettings((s) => ({ ...s, nameEraseWords: tags }))
              }
            />
            <TagEditor
              title="削除対象外ASIN"
              tags={settings.keepASINsOnDelete}
              onChange={(tags) =>
                setSettings((s) => ({
                  ...s,
                  keepASINsOnDelete: tags,
                }))
              }
            />
          </div>
        </section>

        {/* ===== 登録情報 / 通知 ===== */}
        <section
          className={`page-section ${
            page === "profile" ? "active" : ""
          }`}
        >
          <h1 className="page-title">登録情報 / 通知設定</h1>
          <div className="profile-grid">
            <div className="profile-card">
              <div className="settings-subtitle">通知設定</div>
              <div className="toggle-row">
                <div className="toggle-label">出品成功時に通知</div>
                <input
                  type="checkbox"
                  className="toggle-input"
                  checked={settings.notifyOnSuccess}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      notifyOnSuccess: e.target.checked,
                    }))
                  }
                />
              </div>
              <div className="toggle-row">
                <div className="toggle-label">
                  出品失敗・禁止ヒット時に通知
                </div>
                <input
                  type="checkbox"
                  className="toggle-input"
                  checked={settings.notifyOnError}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      notifyOnError: e.target.checked,
                    }))
                  }
                />
              </div>
              <div className="note">
                ※ 今はUIのみ。将来 Slack / メール / Webhook と連携可能。
              </div>
            </div>

            <div className="profile-card">
              <div className="settings-subtitle">
                説明文テンプレート（将来用）
              </div>
              <div className="note">
                将来的には qeasy-api 側でテンプレ管理し、
                autoApplyTemplate=true の場合に自動適用。
              </div>
              <button className="btn btn-green">
                テンプレ編集（ダミー）
              </button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
};

export default App;
