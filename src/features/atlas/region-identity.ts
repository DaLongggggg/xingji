/**
 * 地图地区身份：把行政区名称解析成「本地符号、纸色、纹样」。
 *
 * - 34 个省级区划全部人工指定代表符号；
 * - 省会和广东 21 地市、以及一批常见文化城市人工覆盖；
 * - 其余市/县按名称语义（山、水、动物、建筑、植物等）推断，
 *   没有任何语义线索时用稳定哈希从同一套符号里取一个，保证每块地图
 *   都有固定的、可重复的身份，而不是每次加载随机换图。
 *
 * 本模块只影响 SVG 视觉，不改 GeoJSON、RegionId、投影、计数或拾取。
 */
import type { RegionMotif } from "./region-motif-art";

export type RegionPattern =
  "grain" | "lattice" | "herringbone" | "ridge" | "wave" | "weave" | "blossom" | "terrace";

export type RegionPalette = {
  /** 无记录地区的纸白/浅彩底。 */
  paper: string;
  /** 有记录地区仍保持亮色，只略微转暖。 */
  journal: string;
  /** 纸纹线条色，不用于文字或图标。 */
  ink: string;
  /** 纹样点缀色/徽章描边色。 */
  accent: string;
  /** 徽章图标的深色墨。 */
  glyph: string;
};

export type RegionIdentity = {
  key: string;
  motif: RegionMotif;
  palette: RegionPalette;
  pattern: RegionPattern;
};

/** 十组高明度纸色；名称/顺序稳定，供同一地区的底色与徽章共用。 */
export const REGION_PALETTES: readonly RegionPalette[] = [
  { paper: "#fcfbf7", journal: "#fbf0de", ink: "#9e8d77", accent: "#93a98d", glyph: "#46564c" },
  { paper: "#f7fafb", journal: "#faeede", ink: "#8f9ea2", accent: "#83a3b4", glyph: "#42565e" },
  { paper: "#fcf8f4", journal: "#fbebdd", ink: "#a58f80", accent: "#c3947e", glyph: "#5a4740" },
  { paper: "#fcf9f0", journal: "#f9ecd3", ink: "#a18b61", accent: "#c0a166", glyph: "#544a36" },
  { paper: "#f7faf5", journal: "#faf0de", ink: "#8d9a83", accent: "#86a17e", glyph: "#465540" },
  { paper: "#fbf7f8", journal: "#faede6", ink: "#9f8c8f", accent: "#b98e97", glyph: "#56464b" },
  { paper: "#f9f8fb", journal: "#faefe4", ink: "#928c9f", accent: "#a79ab8", glyph: "#4c4960" },
  { paper: "#f4f9f9", journal: "#fbf0e1", ink: "#899d9c", accent: "#779d9d", glyph: "#3f5352" },
  { paper: "#fcf8f3", journal: "#fbebd5", ink: "#a18c73", accent: "#c79a6c", glyph: "#584a3b" },
  { paper: "#f8fafa", journal: "#fbf0e4", ink: "#8c979a", accent: "#93a8ac", glyph: "#465155" }
] as const;

const PROVINCE_MOTIFS: Record<string, RegionMotif> = {
  北京: "landmark",
  天津: "bridge",
  河北: "wall",
  山西: "pagoda",
  内蒙古: "tent",
  辽宁: "bird",
  吉林: "mountainSnow",
  黑龙江: "snow",
  上海: "building",
  江苏: "bridge",
  浙江: "water",
  安徽: "mountain",
  福建: "leaf",
  江西: "bird",
  山东: "mountain",
  河南: "flower",
  湖北: "pagoda",
  湖南: "mountain",
  广东: "flower",
  广西: "elephant",
  海南: "palm",
  重庆: "soup",
  四川: "panda",
  贵州: "drum",
  云南: "peacock",
  西藏: "mountainSnow",
  陕西: "warrior",
  甘肃: "camel",
  青海: "water",
  宁夏: "castle",
  新疆: "grape",
  台湾: "water",
  香港: "building",
  澳门: "church"
};

/** 省会/首府、广东地市及常见文化城市的人工覆盖；其余走名称语义。 */
const CITY_MOTIFS: Record<string, RegionMotif> = {
  北京: "landmark",
  天津: "bridge",
  石家庄: "bridge",
  太原: "pagoda",
  呼和浩特: "tent",
  沈阳: "landmark",
  长春: "deer",
  哈尔滨: "snow",
  上海: "building",
  南京: "bridge",
  杭州: "leaf",
  合肥: "tree",
  福州: "leaf",
  南昌: "bird",
  济南: "mountain",
  郑州: "landmark",
  武汉: "pagoda",
  长沙: "flower",
  广州: "building",
  南宁: "elephant",
  海口: "palm",
  成都: "panda",
  贵阳: "drum",
  昆明: "peacock",
  拉萨: "mountainSnow",
  西安: "warrior",
  兰州: "camel",
  西宁: "water",
  银川: "castle",
  乌鲁木齐: "grape",
  台北: "building",
  香港: "building",
  澳门: "church",
  重庆: "soup",
  深圳: "building",
  珠海: "shell",
  汕头: "sailboat",
  佛山: "flower",
  韶关: "mountain",
  湛江: "fish",
  肇庆: "mountain",
  江门: "sailboat",
  茂名: "wheat",
  惠州: "mountain",
  梅州: "drum",
  汕尾: "fish",
  河源: "water",
  阳江: "fish",
  清远: "mountain",
  东莞: "factory",
  中山: "bridge",
  潮州: "bridge",
  揭阳: "leaf",
  云浮: "mountain",
  苏州: "bridge",
  扬州: "bridge",
  绍兴: "sailboat",
  厦门: "water",
  泉州: "ship",
  青岛: "sailboat",
  大连: "sailboat",
  烟台: "grape",
  威海: "sailboat",
  洛阳: "flower",
  开封: "flower",
  桂林: "mountain",
  三亚: "palm",
  丽江: "water",
  大理: "water",
  张家界: "mountain",
  敦煌: "camel",
  黄山: "mountain",
  景德镇: "factory",
  曲阜: "landmark",
  婺源: "flower",
  凤凰: "bird"
};

const MOTIF_RULES: readonly [RegExp, RegionMotif][] = [
  [/熊猫/, "panda"],
  [/孔雀/, "peacock"],
  [/骆驼/, "camel"],
  [/大象|象鼻/, "elephant"],
  [/鹿/, "deer"],
  [/虎/, "tiger"],
  [/鹤|鹰|燕|鹭|鸥|凰/, "bird"],
  [/鱼|鲟|鲤/, "fish"],
  [/龟|鳌/, "turtle"],
  [/兔/, "rabbit"],
  [/松鼠|猴/, "squirrel"],
  [/猫/, "cat"],
  [/龙|凤/, "bird"],
  [/长城/, "wall"],
  [/塔/, "pagoda"],
  [/楼|阁/, "tower"],
  [/桥/, "bridge"],
  [/寺|庙|祠|宫|陵|关|门/, "landmark"],
  [/城|堡|寨/, "castle"],
  [/港/, "ship"],
  [/江|河|湖|海|溪|泉|湾|洋|洲|浦|潮|淀|泽/, "water"],
  [/山|峰|岭|岩|峡|谷|坡|岗|崖/, "mountain"],
  [/雪|冰|寒/, "snow"],
  [/林|森/, "forest"],
  [/松|柏|杉|樟|榕|树|木/, "tree"],
  [/花|莲|荷|梅|桃|樱|桂|兰|菊|牡丹/, "flower"],
  [/茶/, "leaf"],
  [/葡萄/, "grape"],
  [/稻|麦|谷|米|棉/, "wheat"],
  [/椰|棕/, "palm"],
  [/阳|日|晴/, "sun"],
  [/钢|铁|煤|矿|工/, "factory"]
];

const FALLBACK_MOTIFS: readonly RegionMotif[] = [
  "mountain",
  "water",
  "forest",
  "flower",
  "bird",
  "landmark",
  "sun",
  "leaf",
  "fish",
  "turtle",
  "bridge",
  "drum"
];

const PATTERN_BY_MOTIF: Record<RegionMotif, RegionPattern> = {
  mountain: "ridge",
  mountainSnow: "ridge",
  water: "wave",
  forest: "grain",
  tree: "grain",
  leaf: "blossom",
  flower: "blossom",
  snow: "lattice",
  sun: "grain",
  panda: "weave",
  bird: "weave",
  fish: "wave",
  rabbit: "weave",
  squirrel: "weave",
  turtle: "weave",
  cat: "weave",
  drum: "herringbone",
  tent: "herringbone",
  sailboat: "wave",
  ship: "wave",
  landmark: "lattice",
  building: "lattice",
  tower: "lattice",
  factory: "lattice",
  castle: "lattice",
  church: "lattice",
  anchor: "wave",
  compass: "lattice",
  binoculars: "lattice",
  backpack: "lattice",
  camera: "lattice",
  grape: "blossom",
  wheat: "terrace",
  palm: "blossom",
  shell: "wave",
  soup: "blossom",
  camel: "weave",
  deer: "weave",
  tiger: "weave",
  elephant: "weave",
  peacock: "weave",
  pagoda: "lattice",
  bridge: "lattice",
  warrior: "lattice",
  wall: "terrace"
};

const ALL_PATTERNS: readonly RegionPattern[] = [
  "grain",
  "lattice",
  "herringbone",
  "ridge",
  "wave",
  "weave",
  "blossom",
  "terrace"
];

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 去掉行政区通名，保留用于匹配的短名；不改原始名称。 */
export function normalizeRegionName(name: string): string {
  return name
    .replace(/\s+/g, "")
    .replace(
      /(维吾尔自治区|回族自治区|壮族自治区|特别行政区|自治区|自治州|自治县|地区|盟|省|市|县|区|旗)$/,
      ""
    )
    .trim();
}

function motifFromName(name: string): RegionMotif | null {
  const key = normalizeRegionName(name);
  for (const [pattern, motif] of MOTIF_RULES) {
    if (pattern.test(key)) return motif;
  }
  return null;
}

/**
 * 解析地区身份。同一 regionId 的底色、纹样、角度稳定；名称只决定符号。
 * 人工映射优先，其次名称语义，最后稳定哈希兜底。
 */
export function resolveRegionIdentity(name: string, regionId: string): RegionIdentity {
  const key = normalizeRegionName(name);
  const curated = PROVINCE_MOTIFS[key] ?? CITY_MOTIFS[key];
  const motif =
    curated ??
    motifFromName(key) ??
    FALLBACK_MOTIFS[stableHash(`${regionId}:${key}`) % FALLBACK_MOTIFS.length];
  const palette = REGION_PALETTES[stableHash(`${regionId}:paper`) % REGION_PALETTES.length];
  const pattern =
    PATTERN_BY_MOTIF[motif] ??
    ALL_PATTERNS[stableHash(`${regionId}:pattern`) % ALL_PATTERNS.length];
  return { key, motif, palette, pattern };
}

/** 供测试与调试查看人工覆盖了几种省级身份。 */
export function curatedProvinceMotifs(): Readonly<Record<string, RegionMotif>> {
  return PROVINCE_MOTIFS;
}
