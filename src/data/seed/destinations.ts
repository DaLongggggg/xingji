import type { Destination } from "@/server/shared/types";

export const destinations: Destination[] = [
  {
    id: "dest-guangdong",
    provinceId: "province-guangdong",
    name: "广东",
    slug: "guangdong",
    level: "province",
    center: { longitude: 113.27, latitude: 23.13 },
    mapZoom: 7,
    scopeNote: "第一版覆盖广州、东莞和深圳三个示范地区。",
    aliases: ["广东省", "粤"],
    status: "published"
  },
  {
    id: "dest-guangzhou",
    provinceId: "province-guangdong",
    name: "广州",
    slug: "guangzhou",
    level: "prefecture",
    center: { longitude: 113.27, latitude: 23.13 },
    mapZoom: 10,
    scopeNote: "以广州市及可纳入同一行程的周边区县为范围。",
    aliases: ["广州市", "羊城"],
    status: "published"
  },
  {
    id: "dest-dongguan",
    provinceId: "province-guangdong",
    name: "东莞",
    slug: "dongguan",
    level: "prefecture",
    center: { longitude: 113.75, latitude: 23.02 },
    mapZoom: 10,
    scopeNote: "以东莞市各镇街及可当天往返的周边区域为范围。",
    aliases: ["东莞市"],
    status: "published"
  },
  {
    id: "dest-shenzhen",
    provinceId: "province-guangdong",
    name: "深圳",
    slug: "shenzhen",
    level: "prefecture",
    center: { longitude: 114.06, latitude: 22.55 },
    mapZoom: 10,
    scopeNote: "以深圳市各区和大鹏半岛为范围。",
    aliases: ["深圳市", "鹏城"],
    status: "published"
  },
  {
    id: "dest-xinjiang",
    provinceId: "province-xinjiang",
    name: "新疆",
    slug: "xinjiang",
    level: "province",
    center: { longitude: 87.62, latitude: 43.82 },
    mapZoom: 5,
    scopeNote: "第一版覆盖乌鲁木齐、伊宁（伊犁地区）和喀什三个示范地区。",
    aliases: ["新疆维吾尔自治区", "新"],
    status: "published"
  },
  {
    id: "dest-urumqi",
    provinceId: "province-xinjiang",
    name: "乌鲁木齐",
    slug: "urumqi",
    level: "prefecture",
    center: { longitude: 87.62, latitude: 43.82 },
    mapZoom: 9,
    scopeNote: "以乌鲁木齐市及可当天往返的天山北麓周边为范围。",
    aliases: ["乌鲁木齐市", "乌市"],
    status: "published"
  },
  {
    id: "dest-yining",
    provinceId: "province-xinjiang",
    name: "伊宁（伊犁地区）",
    slug: "yining",
    level: "prefecture",
    center: { longitude: 81.32, latitude: 43.92 },
    mapZoom: 7,
    scopeNote: "以伊宁市为中心，包含伊犁州内适合组成同一次旅行的县市和景区。",
    aliases: ["伊宁", "伊宁市", "伊犁", "伊犁地区"],
    status: "published"
  },
  {
    id: "dest-kashgar",
    provinceId: "province-xinjiang",
    name: "喀什",
    slug: "kashgar",
    level: "prefecture",
    center: { longitude: 75.99, latitude: 39.47 },
    mapZoom: 7,
    scopeNote: "以喀什市为中心，包含塔什库尔干等可组成南疆行程的周边地区。",
    aliases: ["喀什市", "喀什地区"],
    status: "published"
  },
  {
    id: "dest-tibet",
    provinceId: "province-tibet",
    name: "西藏",
    slug: "tibet",
    level: "province",
    center: { longitude: 91.11, latitude: 29.65 },
    mapZoom: 6,
    scopeNote: "第一版覆盖拉萨、林芝和日喀则三个示范地区。",
    aliases: ["西藏自治区", "藏"],
    status: "published"
  },
  {
    id: "dest-lhasa",
    provinceId: "province-tibet",
    name: "拉萨",
    slug: "lhasa",
    level: "prefecture",
    center: { longitude: 91.11, latitude: 29.65 },
    mapZoom: 9,
    scopeNote: "以拉萨市及可纳入同一地区行程的周边县区为范围。",
    aliases: ["拉萨市"],
    status: "published"
  },
  {
    id: "dest-nyingchi",
    provinceId: "province-tibet",
    name: "林芝",
    slug: "nyingchi",
    level: "prefecture",
    center: { longitude: 94.36, latitude: 29.65 },
    mapZoom: 8,
    scopeNote: "以巴宜区为中心，包含波密、工布江达和米林等旅行区域。",
    aliases: ["林芝市"],
    status: "published"
  },
  {
    id: "dest-shigatse",
    provinceId: "province-tibet",
    name: "日喀则",
    slug: "shigatse",
    level: "prefecture",
    center: { longitude: 88.89, latitude: 29.27 },
    mapZoom: 7,
    scopeNote: "以桑珠孜区为中心，包含江孜、定日、亚东和吉隆等旅行区域。",
    aliases: ["日喀则市"],
    status: "published"
  }
];
