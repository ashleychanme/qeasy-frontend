// src/api/qeasy.ts
// フロントから Qeasy API サーバ(server.mjs)を叩くためのラッパ

export type AmazonItemInfo = {
  asin: string;
  price: number;
  sellerCount: number;
  title?: string;
  image?: string;
  isPrime?: boolean;
  shipDays?: number;
};

export type Qoo10ListingPayload = {
  asin: string;
  price: number;
  shippingCode: string;
  title: string;
  imageUrl?: string;
  stock?: number;
  categoryNo?: number;
  jan?: string;
};

export type CreateListingResult = {
  asin: string;
  ok: boolean;
  message?: string;
  code?: string;
  qoo10ItemCode?: string;
};

export type QeasyItem = {
  asin: string;
  name: string;
  jan?: string;
  qoo10Id?: string;
  mainImage?: string;
  amazonPrice?: number;
  inStock?: boolean;
  updatedAt?: string;
};

const API_BASE =
  import.meta.env.VITE_QEASY_API_BASE || "http://localhost:4000";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "GET",
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`${path} ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: any): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `${path} ${res.status} ${res.statusText} ${text}`.trim()
    );
  }

  return (await res.json()) as T;
}

/** Amazon 一括取得（server.mjs → Keepa or モック） */
export async function fetchAmazonBulk(
  asins: string[]
): Promise<AmazonItemInfo[]> {
  if (!asins.length) return [];
  try {
    return await postJson<AmazonItemInfo[]>("/amazon/bulk", { asins });
  } catch {
    return [];
  }
}

/** Qoo10 既存チェック */
export async function checkQoo10Existing(
  asins: string[]
): Promise<string[]> {
  if (!asins.length) return [];
  try {
    return await postJson<string[]>("/qoo10/check-existing", { asins });
  } catch {
    return [];
  }
}

/** Qoo10 出品作成 */
export async function createQoo10Listings(
  items: Qoo10ListingPayload[]
): Promise<CreateListingResult[]> {
  if (!items.length) return [];
  try {
    return await postJson<CreateListingResult[]>("/qoo10/create-listings", {
      items,
    });
  } catch {
    // サーバ落ちてる場合もUI側で見えるようにする
    return items.map((it) => ({
      asin: it.asin,
      ok: false,
      message: "出品API呼び出しに失敗しました。（サーバ未接続の可能性）",
    }));
  }
}

/** 設定取得 */
export async function fetchSettings(): Promise<any | null> {
  try {
    return await getJson<any>("/settings");
  } catch {
    return null;
  }
}

/** 設定保存 */
export async function saveSettings(settings: any): Promise<void> {
  try {
    await postJson<{}>("/settings", settings);
  } catch {
    // サーバ未実装でも無視
  }
}

/** 商品一覧取得 */
export async function fetchItems(): Promise<QeasyItem[]> {
  try {
    return await getJson<QeasyItem[]>("/items");
  } catch {
    return [];
  }
}

/** 商品一覧保存 */
export async function saveItems(items: QeasyItem[]): Promise<void> {
  try {
    await postJson<{}>("/items", { items });
  } catch {
    // サーバ未実装でも無視
  }
}

/** 最新化トリガー（定期バッチ用） */
export async function refreshItems(): Promise<void> {
  try {
    await postJson<{}>("/items/refresh", {});
  } catch {
    // 失敗しても致命的ではないので握りつぶす
  }
}
