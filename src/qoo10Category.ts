// qoo10Category.ts みたいな名前で保存して使う想定

// ==============================
// 型定義
// ==============================

export type MainCategoryCode =
  | "120000"    // ビューティ（化粧品／基礎化粧／メイク）
  | "130000"    // サプリ・健康食品
  | "120000033" // 美容・健康家電（ドライヤー・ヘアアイロン・美顔器等）
  | "100000018"; // 日用品雑貨（カミソリ等）

export type BeautyCatCode =
  | "120000012" // スキンケア
  | "120000013" // ベースメイク
  | "120000014" // ポイントメイク
  | "120000017" // UVケア（日焼け止め）
  | "120000018" // ボディ・ハンド・フットケア
  | "120000020" // ヘアケア
  | "120000021" // ネイル
  | "120000022"; // 香水・フレグランス

export interface Qoo10CategoryDecision {
  main: MainCategoryCode;
  beautySecondSubCat?: BeautyCatCode; // main が "120000" のときだけ使用
}

// ==============================
// サプリ判定（メインカテゴリ 130000）
// ==============================

const SUPPLEMENT_KEYWORDS: string[] = [
  "サプリメント",
  "サプリ",
  "健康食品",
  "機能性表示食品",
  "プロテイン",
  "ホエイプロテイン",
  "ソイプロテイン",
  "青汁",
  "酵素",
  "乳酸菌",
  "オメガ3",
  "EPA",
  "DHA",
  "ダイエットサプリ",
  "美容サプリ",
];

function isSupplement(title: string): boolean {
  return SUPPLEMENT_KEYWORDS.some((kw) => title.includes(kw));
}

// ==============================
// 美容家電判定（メインカテゴリ 120000033）
// ==============================

// ドライヤー・ヘアアイロン・美顔器など
const BEAUTY_APPLIANCE_KEYWORDS: string[] = [
  // ドライヤー系
  "ドライヤー",
  "ヘアドライヤー",
  "ヘアードライヤー",

  // ヘアアイロン系
  "ヘアアイロン",
  "ストレートアイロン",
  "カールアイロン",
  "2WAYアイロン",
  "2WAY ヘアアイロン",
  "コテ",

  // 美顔器系
  "美顔器",
  "フェイススチーマー",
  "イオンスチーマー",
  "スチーマー",
];

// 電化製品っぽさのヒント
const ELECTRIC_HINTS: string[] = [
  "電動",
  "電気",
  "充電式",
  "コードレス",
  "IPX",
  "防水",
];

// ==============================
// カミソリ（日用品雑貨 100000018）判定
// ==============================

const RAZOR_KEYWORDS: string[] = [
  "カミソリ",
  "髭剃り",
  "ひげそり",
  "ヒゲソリ",
  "シェーバー",
  "シェイバー",
];

const DAILY_RAZOR_HINTS: string[] = [
  "替刃",
  "替え刃",
  "ホルダー(刃付き",
  "剃刀",
];

function isBeautyAppliance(title: string): boolean {
  // まずは明示的な家電ワード
  if (BEAUTY_APPLIANCE_KEYWORDS.some((kw) => title.includes(kw))) {
    return true;
  }

  // 電動シェーバー・電動脱毛器などを家電扱いしたいケース
  if (
    RAZOR_KEYWORDS.some((kw) => title.includes(kw)) &&
    ELECTRIC_HINTS.some((kw) => title.includes(kw))
  ) {
    return true;
  }

  // 将来的に ReFa / KINUJO などのブランド名で拾いたければここに追加
  return false;
}

function isDailyRazor(title: string): boolean {
  if (!RAZOR_KEYWORDS.some((kw) => title.includes(kw))) return false;

  // 電動っぽさが無く、替刃・ホルダー・剃刀系なら日用品扱い
  if (!ELECTRIC_HINTS.some((kw) => title.includes(kw))) return true;
  if (DAILY_RAZOR_HINTS.some((kw) => title.includes(kw))) return true;

  return false;
}

// ==============================
// メインカテゴリ判定
// ==============================

export function getMainCategoryCode(
  titleRaw: string | null | undefined
): MainCategoryCode {
  const title = titleRaw ?? "";

  if (isSupplement(title)) return "130000";
  if (isBeautyAppliance(title)) return "120000033";
  if (isDailyRazor(title)) return "100000018";

  // 残りはビューティ（化粧品・メイク・UV等）
  return "120000";
}

// ==============================
// ビューティ内細分け（SecondSubCat）
// ==============================

type BeautyRule = { code: BeautyCatCode; keywords: string[] };

// 「より限定的・優先したい」カテゴリほど上に置く
const BEAUTY_RULES: BeautyRule[] = [
  // 1. UVケアを最優先
  {
    code: "120000017", // UVケア
    keywords: [
      "日焼け止め",
      "UVケア",
      "UVカット",
      "サンスクリーン",
      "サンブロック",
      "サンプロテクター",
      "サンクッション",
      "UVクリーム",
      "UVミルク",
      "UVジェル",
    ],
  },

  // 2. ベースメイク
  {
    code: "120000013",
    keywords: [
      "ファンデーション",
      "クッションファンデ",
      "クッションファンデーション",
      "リキッドファンデ",
      "パウダーファンデ",
      "BBクリーム",
      "CCクリーム",
      "化粧下地",
      "メイク下地",
      "プライマー",
      "コンシーラー",
      "フェイスパウダー",
      "ルースパウダー",
      "プレストパウダー",
      "トーンアップベース",
      "トーンアップクリーム",
    ],
  },

  // 3. ポイントメイク
  {
    code: "120000014",
    keywords: [
      "アイシャドウ",
      "アイグロス",
      "アイライナー",
      "ジェルライナー",
      "ペンシルライナー",
      "マスカラ",
      "チーク",
      "ブラッシュ",
      "ハイライト",
      "シェーディング",
      "コントゥア",
      "リップ",
      "口紅",
      "グロス",
      "ティント",
      "リップオイル",
      "リップバーム",
      "アイブロウ",
      "眉マスカラ",
      "ブロウ",
    ],
  },

  // 4. ヘアケア
  {
    code: "120000020",
    keywords: [
      "シャンプー",
      "ｼｬﾝﾌﾟｰ",
      "コンディショナー",
      "トリートメント",
      "ヘアマスク",
      "ヘアパック",
      "ヘアオイル",
      "ヘアミスト",
      "ヘアエッセンス",
      "ヘアスプレー",
      "ヘアワックス",
      "スタイリング",
      "スタイリングジェル",
      "育毛剤",
      "スカルプ",
      "頭皮ケア",
      "ヘアカラー",
      "白髪染め",
      "ヘナ",
    ],
  },

  // 5. ネイル
  {
    code: "120000021",
    keywords: [
      "ネイル",
      "マニキュア",
      "ジェルネイル",
      "トップコート",
      "ベースコート",
      "ネイルポリッシュ",
      "ネイルカラー",
      "ネイルオイル",
      "キューティクルオイル",
    ],
  },

  // 6. 香水・フレグランス
  {
    code: "120000022",
    keywords: [
      "香水",
      "フレグランス",
      "オードトワレ",
      "オードパルファム",
      "オーデコロン",
      "ボディミスト",
      "ヘアミスト",
      "パルファム",
    ],
  },

  // 7. ボディ・ハンド・フットケア
  {
    code: "120000018",
    keywords: [
      "ボディクリーム",
      "ボディミルク",
      "ボディローション",
      "ボディジェル",
      "ボディオイル",
      "ボディソープ",
      "ボディウォッシュ",
      "シャワージェル",
      "ハンドクリーム",
      "ハンドジェル",
      "ハンドローション",
      "フットクリーム",
      "フットケア",
      "ボディスクラブ",
      "ボディスクラップ",
      "バスソルト",
      "入浴剤",
      "バスボム",
      "デオドラント",
      "制汗",
      "ボディバター",
      "ボディミスト",
    ],
  },

  // 8. スキンケア（最後の受け皿）
  {
    code: "120000012",
    keywords: [
      "化粧水",
      "ローション",
      "トナー",
      "乳液",
      "エマルジョン",
      "美容液",
      "セラム",
      "エッセンス",
      "アンプル",
      "クリーム",
      "ジェルクリーム",
      "ジェル",
      "オールインワンジェル",
      "オールインワンゲル",
      "クレンジング",
      "クレンジングオイル",
      "クレンジングバーム",
      "クレンジングジェル",
      "クレンジングミルク",
      "洗顔",
      "洗顔フォーム",
      "フォームクレンザー",
      "シートマスク",
      "フェイスマスク",
      "マスク",
      "パック",
      "スリーピングマスク",
      "スリーピングパック",
      "ピーリング",
      "スクラブ",
      "角質ケア",
      "CICA",
      "シカ",
      "美白美容液",
      "毛穴ケア",
    ],
  },
];

export function getBeautySecondSubCat(title: string): BeautyCatCode {
  for (const rule of BEAUTY_RULES) {
    for (const kw of rule.keywords) {
      if (title.includes(kw)) {
        return rule.code;
      }
    }
  }

  // どれにも当てはまらなければ、とりあえずスキンケア扱い
  return "120000012";
}

// ==============================
// 総合判定関数（これだけ呼べばOK）
// ==============================

export function classifyQoo10Category(
  title: string | null | undefined
): Qoo10CategoryDecision {
  const main = getMainCategoryCode(title);

  if (main === "120000") {
    const sub = getBeautySecondSubCat(title ?? "");
    return { main, beautySecondSubCat: sub };
  }

  // サプリ／家電／日用品はメインカテゴリだけ
  return { main };
}

/*
使い方イメージ：

const title = "SALONIA ストレートヘアアイロン 24mm";
const cat = classifyQoo10Category(title);
// cat.main === "120000033" （美容家電）
// cat.beautySecondSubCat は undefined

const title2 = "VT CICA デイリースージングマスク 30枚入";
const cat2 = classifyQoo10Category(title2);
// cat2.main === "120000"
// cat2.beautySecondSubCat === "120000012" （スキンケア）
*/
