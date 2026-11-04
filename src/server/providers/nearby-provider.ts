import type { Destination, GeoPoint, NearbyPlace } from "@/server/shared/types";

export interface NearbyProvider {
  list(destination: Destination, center: GeoPoint): Promise<NearbyPlace[]>;
}

const regionalFoods: Record<string, string[]> = {
  "province-guangdong": ["早茶点心", "烧鹅与粤菜", "糖水铺"],
  "province-xinjiang": ["手抓饭与烤肉", "拌面小馆", "馕与奶茶"],
  "province-tibet": ["藏面与甜茶", "牦牛肉餐馆", "藏式家常菜"]
};

/** 本地周边演示 Provider；真实高德接入后保持相同输出结构。 */
export class LocalNearbyProvider implements NearbyProvider {
  async list(destination: Destination, center: GeoPoint): Promise<NearbyPlace[]> {
    const foodNames = regionalFoods[destination.provinceId] ?? ["本地风味", "城市小馆", "夜市小吃"];
    const foodPlaces = foodNames.map((name, index): NearbyPlace => ({
      id: `food-${destination.slug}-${index + 1}`,
      name: `${destination.name}·${name}`,
      kind: "food",
      location: {
        longitude: center.longitude + (index - 1) * 0.008,
        latitude: center.latitude + (1 - index) * 0.006
      },
      recommendationNote: "按行程中心位置生成的风味类型建议，请结合地图营业信息选择具体门店。",
      sourceLabel: "行迹本地演示建议"
    }));

    const hotelPlaces: NearbyPlace[] = [
      {
        id: `hotel-${destination.slug}-1`,
        name: `${destination.name}中心交通便利区`,
        kind: "hotel",
        location: center,
        recommendationNote: "优先选择公共交通和餐饮较集中的区域，减少每日往返。",
        sourceLabel: "行迹路线中心估算"
      }
    ];
    return [...foodPlaces, ...hotelPlaces];
  }
}

export const nearbyProvider = new LocalNearbyProvider();
