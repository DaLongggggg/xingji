import type { Province } from "@/server/shared/types";

const provinceRows: Array<[string, string, string]> = [
  ["北京", "京", "beijing"],
  ["天津", "津", "tianjin"],
  ["河北", "冀", "hebei"],
  ["山西", "晋", "shanxi"],
  ["内蒙古", "内蒙古", "inner-mongolia"],
  ["辽宁", "辽", "liaoning"],
  ["吉林", "吉", "jilin"],
  ["黑龙江", "黑", "heilongjiang"],
  ["上海", "沪", "shanghai"],
  ["江苏", "苏", "jiangsu"],
  ["浙江", "浙", "zhejiang"],
  ["安徽", "皖", "anhui"],
  ["福建", "闽", "fujian"],
  ["江西", "赣", "jiangxi"],
  ["山东", "鲁", "shandong"],
  ["河南", "豫", "henan"],
  ["湖北", "鄂", "hubei"],
  ["湖南", "湘", "hunan"],
  ["广东", "粤", "guangdong"],
  ["广西", "桂", "guangxi"],
  ["海南", "琼", "hainan"],
  ["重庆", "渝", "chongqing"],
  ["四川", "川", "sichuan"],
  ["贵州", "贵", "guizhou"],
  ["云南", "云", "yunnan"],
  ["西藏", "藏", "tibet"],
  ["陕西", "陕", "shaanxi"],
  ["甘肃", "甘", "gansu"],
  ["青海", "青", "qinghai"],
  ["宁夏", "宁", "ningxia"],
  ["新疆", "新", "xinjiang"],
  ["香港", "港", "hong-kong"],
  ["澳门", "澳", "macao"],
  ["台湾", "台", "taiwan"]
];

const featuredNames = new Set(["广东", "新疆", "西藏"]);

/** 34 个省级行政区。转盘直接使用此完整数组，保证每项只出现一次。 */
export const provinces: Province[] = provinceRows.map(([name, shortName, slug], index) => ({
  id: `province-${slug}`,
  name,
  shortName,
  slug,
  adminCode: String(index + 1).padStart(2, "0"),
  isFeatured: featuredNames.has(name),
  status: featuredNames.has(name) ? "published" : "building"
}));
