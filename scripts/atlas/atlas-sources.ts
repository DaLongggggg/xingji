/**
 * 015 地图素材来源确认与处置清单（人工维护，可随版本管理）。
 *
 * 只登记**已确认**的来源、版本与处置决定；脚本据此校验，不猜测、不按名称模糊匹配。
 * 原始素材与准备产物都只在本地：`map-data/`（只读）与 `.local/atlas/`（Git 忽略），
 * 不进入客户端 bundle，也不复制进 public。
 */

export type AtlasAssetDisposition =
  /** 已使用：生成到本地数据包并接入映射。 */
  | "used"
  /** 历史/额外素材：保留在本地，不接入目录或映射（记录原因）。 */
  | "historical-extra"
  /** 待匹配：来源或语义未确认，先不接入（记录原因）。 */
  | "pending-match"
  /** 对应省级自身：不产生同名子级（直辖市、港澳）。 */
  | "province-self";

/** 全国分省边界包：保留原 34 省身份，仅用固定版本的港澳区面细化两地。 */
export const NATIONAL_SOURCE = {
  sourceId: "local-json-cn",
  sourceVersion: "33cd37ab22628858654d839f5d88a2deec372463+7aa2c5fabc6a892015625898c3482874b233f9de",
  origin: "yezongyang/china-geojson@33cd37ab22628858654d839f5d88a2deec372463 + zhChuXiao/ChinaGeoJson@7aa2c5fabc6a892015625898c3482874b233f9de (港澳)",
  /** 本地开发入口文件名（仅在 .local/atlas/ 下使用）。 */
  localFileName: "cn-provinces.json",
  /** 原 34 省包的 blob；派生包哈希由准备脚本另行核验。 */
  gitBlobSha1: "3ba8e748bcfed52bf433090761b0b4afaea0dfd4",
  bytes: 192361,
  sha256: "6b90035b03d179507c0b760463534dec799652d2904c88b4d9928e451be5c4d2",
  refinements: [
    { sourceRegionId: "81", name: "香港特别行政区", sourceFile: "province/香港特别行政区.json", features: 18, gitBlobSha1: "66928b7703a210bc0f1bc617b5b12655423bd854" },
    { sourceRegionId: "82", name: "澳门特别行政区", sourceFile: "province/澳门特别行政区.json", features: 8, gitBlobSha1: "04df1093921427087c9d4e9be293e46b726e5ccc" }
  ]
} as const;

/** 各省城市包来源：echarts-china-cities-js 的 shape-only（城市外轮廓）。 */
export const CITY_SOURCE = {
  sourceId: "echarts-cities-shape-only",
  sourceVersion: "e3318090406a64c48fd26a4020b11ea6b590a007",
  origin: "echarts-maps/echarts-china-cities-js@e3318090406a64c48fd26a4020b11ea6b590a007",
  /** 相对仓库根的素材目录（只读）。 */
  assetRoot: "map-data",
  /** 只使用 shape-only，不把区县当城市。 */
  assetSubdir: "shape-only"
} as const;

/** 旧来源（014-C 开发入口的临时别名），仅用于说明历史，不再登记为支持来源。 */
export const RETIRED_SOURCES = [
  {
    sourceId: "local-json",
    sourceVersion: "33cd37ab22628858654d839f5d88a2deec372463",
    reason: "014-C 开发文件入口的临时命名空间；015 起改用按包登记的 sourceId。"
  }
] as const;

/**
 * 省级目录 → 全国来源编号。目录名来自素材组织方式，`sourceRegionId` 来自
 * `china.json` 的 `properties.id`，**不是**官方 adcode。
 */
export const PROVINCE_DIRECTORIES: { dir: string; sourceRegionId: string }[] = [
  { dir: "bei_jing", sourceRegionId: "11" },
  { dir: "tian_jin", sourceRegionId: "12" },
  { dir: "he_bei", sourceRegionId: "13" },
  { dir: "shan_xi", sourceRegionId: "14" },
  { dir: "nei_meng_gu", sourceRegionId: "15" },
  { dir: "liao_ning", sourceRegionId: "21" },
  { dir: "ji_lin", sourceRegionId: "22" },
  { dir: "hei_long_jiang", sourceRegionId: "23" },
  { dir: "shang_hai", sourceRegionId: "31" },
  { dir: "jiang_su", sourceRegionId: "32" },
  { dir: "zhe_jiang", sourceRegionId: "33" },
  { dir: "an_hui", sourceRegionId: "34" },
  { dir: "fu_jian", sourceRegionId: "35" },
  { dir: "jiang_xi", sourceRegionId: "36" },
  { dir: "shan_dong", sourceRegionId: "37" },
  { dir: "he_nan", sourceRegionId: "41" },
  { dir: "hu_bei", sourceRegionId: "42" },
  { dir: "hu_nan", sourceRegionId: "43" },
  { dir: "guang_dong", sourceRegionId: "44" },
  { dir: "guang_xi", sourceRegionId: "45" },
  { dir: "hai_nan", sourceRegionId: "46" },
  { dir: "chong_qing", sourceRegionId: "50" },
  { dir: "si_chuan", sourceRegionId: "51" },
  { dir: "gui_zhou", sourceRegionId: "52" },
  { dir: "yun_nan", sourceRegionId: "53" },
  { dir: "xi_zang", sourceRegionId: "54" },
  { dir: "shaan_xi", sourceRegionId: "61" },
  { dir: "gan_su", sourceRegionId: "62" },
  { dir: "qing_hai", sourceRegionId: "63" },
  { dir: "ning_xia", sourceRegionId: "64" },
  { dir: "xin_jiang", sourceRegionId: "65" },
  { dir: "tai_wan", sourceRegionId: "71" },
  { dir: "xiang_gang", sourceRegionId: "81" },
  { dir: "ao_men", sourceRegionId: "82" }
];

/**
 * 目录内**单个子级文件与省级同名**的省份：直辖市与港澳。
 * 这些省份保留省级手帐入口，不制造同名城市下钻；文件登记为 province-self。
 */
export const PROVINCE_SELF_DIRECTORIES = [
  "bei_jing",
  "tian_jin",
  "shang_hai",
  "chong_qing",
  "xiang_gang",
  "ao_men"
] as const;

/** 名称核对：来源只有简称（如“广州”）时补的后缀；不做其他改写。 */
export const PREFECTURE_NAME_SUFFIX = "市";

/**
 * 显示名已带后缀或本身是完整名称的例外（名称核对结果，不猜语义）。
 * - 广东沿用 014-C 已存名称“广州市…”，保持既有引用不变；
 * - 县级 / 自治州 / 地区 / 盟 / 县与台湾素材保持来源原名，不做行政区改写。
 */
export const NAME_AS_SOURCE_DIRECTORIES = ["tai_wan"] as const;

/** 县级或其他非地级子级：仍按素材来源接入，但在清单中显式标注，避免被读成地级市。 */
export const SUB_PREFECTURE_HINT_DIRECTORIES = ["hai_nan", "xin_jiang"] as const;

/** 素材目录里确认存在但**不作为城市**的例外项。 */
export const EXTRA_ASSET_ENTRIES = [
  {
    dir: "guang_dong",
    fileStem: "guang3_dong1_dong1_sha1_qun2_dao3",
    name: "东沙群岛",
    disposition: "historical-extra" as AtlasAssetDisposition,
    reason: "广东 22 份素材中的额外项；不作为第 22 个地级市，也不伪造行政区。"
  }
] as const;

/** 每个省级包的分片上限：单响应 10 MiB（与既有边界文件上限一致）。 */
export const PACKAGE_MAX_BYTES = 10 * 1024 * 1024;

/** 准备产物的输出目录（相对仓库根，Git 忽略）。 */
export const ATLAS_OUTPUT_DIR = ".local/atlas";
