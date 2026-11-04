"use client";

/**
 * P6-03：旅行与地点手动管理的**唯一协调入口**。
 *
 * 职责（只有这些）：
 * - 从当前档案投影出旅行/地点/当前篇关系，并按需报告损坏记录（`inspectTripStore`）；
 * - 把用户动作翻译成 `TripCommand`，交给 `commitTripCommand`（→ 既有 `commitJournalChange`
 *   同一事务 + `expectedRevision` CAS），成功后回读档案；
 * - 把 no-op / 冲突 / 失败 / 迟到都表达成**可见**结果，不静默吞掉。
 *
 * 边界：不新建 Repository/Manager/队列；不重写 024 自动保存；不接 AI/EXIF、地理编码或地图供应商。
 */
import { useEffect, useRef, useState } from "react";
import type { ArchiveCore, NotebookRepository } from "@/features/notebook/notebook-repository";
import { commitTripCommand, type TripCommand } from "./trip-commands";
import {
  inspectTripStore,
  projectTripSlice,
  readTripSlice,
  type PagePlaceLinkSource,
  type Place,
  type Trip
} from "./trip-model";

export type TripPlaceDraft = {
  title: string;
  startDate: string;
  endDate: string;
};

export type PlaceDraft = {
  name: string;
  latitude: string;
  longitude: string;
  address: string;
};

export type UseTripsOptions = {
  repository: NotebookRepository;
  archive: ArchiveCore;
  /** 当前可关联的篇（编辑器里的那一篇）；null 表示没有目标。 */
  targetPageId: string | null;
  enabled: boolean;
  /** 提交成功后的既有回读入口（复用 024/档案刷新，不另建状态）。 */
  onReloadArchive?: () => Promise<void>;
  onNotice?: (message: string) => void;
  now?: () => Date;
  createId?: (prefix: string) => string;
};

export type UseTripsApi = {
  trips: Trip[];
  places: Place[];
  /** 垃圾桶里的旅行/地点（可恢复或永久删除）。 */
  deletedTrips: Trip[];
  deletedPlaces: Place[];
  /** 当前篇的行程关联与地点关联（仅列仍有效的目标）。 */
  pageTripIds: string[];
  pagePlaceIds: string[];
  /** 结构性损坏的可见报告（原样保留，不会被自动清理）。 */
  damage?: string;
  busy: boolean;
  message?: string;
  createTrip: (draft: TripPlaceDraft) => Promise<void>;
  updateTrip: (id: string, draft: TripPlaceDraft) => Promise<void>;
  deleteTrip: (id: string) => Promise<void>;
  restoreTrip: (id: string) => Promise<void>;
  purgeTrip: (id: string) => Promise<void>;
  createPlace: (draft: PlaceDraft) => Promise<void>;
  updatePlace: (id: string, draft: PlaceDraft) => Promise<void>;
  deletePlace: (id: string) => Promise<void>;
  restorePlace: (id: string) => Promise<void>;
  purgePlace: (id: string) => Promise<void>;
  linkTripToPage: (tripId: string) => Promise<void>;
  unlinkTripFromPage: (tripId: string) => Promise<void>;
  linkPlaceToPage: (placeId: string) => Promise<void>;
  unlinkPlaceFromPage: (placeId: string, source: PagePlaceLinkSource) => Promise<void>;
};

/** 身份键：目标篇 + 启用状态；任何一次变化都必须让旧操作代际失效。 */
function identityKeyOf(options: Pick<UseTripsOptions, "targetPageId" | "enabled">): string {
  return `${options.targetPageId ?? ""}\u0001${options.enabled ? "1" : "0"}`;
}

let tripIdSequence = 0;
function defaultTripId(prefix: string): string {
  tripIdSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${tripIdSequence.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/**
 * 文本坐标 → WGS84 数字对；两者都空表示**未知**（不返回 0），任一非法则给出错误。
 * 合法 `(0,0)` 会被如实保留。
 */
export function parseCoordinates(
  latitude: string,
  longitude: string
): { ok: true; value?: { latitude: number; longitude: number } } | { ok: false; detail: string } {
  const lat = latitude.trim();
  const lon = longitude.trim();
  if (lat === "" && lon === "") return { ok: true };
  if (lat === "" || lon === "") {
    return { ok: false, detail: "纬度和经度要么都填，要么都留空（留空表示坐标未知）。" };
  }
  const latitudeValue = Number(lat);
  const longitudeValue = Number(lon);
  if (!Number.isFinite(latitudeValue) || !Number.isFinite(longitudeValue)) {
    return { ok: false, detail: "坐标必须是数字。" };
  }
  if (latitudeValue < -90 || latitudeValue > 90 || longitudeValue < -180 || longitudeValue > 180) {
    return { ok: false, detail: "坐标超出 WGS84 范围（纬度 -90..90、经度 -180..180）。" };
  }
  return { ok: true, value: { latitude: latitudeValue, longitude: longitudeValue } };
}

export function useTrips(options: UseTripsOptions): UseTripsApi {
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  /**
   * 操作身份：`opId`（每次命令递增）+ 身份代际 `sessionRef`（卸载、目标篇切换、启用状态切换都递增）
   * + 发起时的 targetPageId/enabled 值。四者共同判定“还是当前会话”。
   *
   * F1：代际必须**不可逆**递增——只比较当前值会让 A→B→A（或 enabled true→false→true）
   * 后的旧操作重新匹配当前身份，从而把迟到的成功/失败发布到新会话。
   */
  const opIdRef = useRef(0);
  const sessionRef = useRef(0);
  const [session, setSession] = useState(0);
  /** 上一次渲染的身份（目标篇 + 启用状态），用于在渲染期检测切换。 */
  const [renderedIdentity, setRenderedIdentity] = useState(() => identityKeyOf(options));

  /*
   * F1：目标篇/启用状态每次切换都在**渲染期**递增代际并归还 busy
   * （React 文档认可的“props 变化时调整 state”模式，避免 effect 里再补一次 setState）。
   * 切回同一篇不会回到旧代际，因此旧操作永久失效。
   */
  const identityKey = identityKeyOf(options);
  if (renderedIdentity !== identityKey) {
    setRenderedIdentity(identityKey);
    setSession(session + 1);
    setBusy(false);
  }

  useEffect(() => {
    // 把当前代际同步给异步回调读取（不在渲染期写 ref，避免读到未提交的代际）。
    sessionRef.current = session;
  }, [session]);

  useEffect(
    () => () => {
      // 卸载：作废在途回调（提交本身由事务/CAS 自行收敛，不在这里撤销）。
      opIdRef.current += 1;
    },
    []
  );

  const archive = options.archive;
  const rawStore = readTripSlice(archive);
  /**
   * R1：界面只消费通过记录校验的记录（`projectTripSlice` 是只读投影）。
   * 损坏记录仍留在存储里，并由下面的 `damage` 如实报告；投影结果绝不写回。
   */
  const visible = projectTripSlice(rawStore);
  const activeTrips = visible.trips.filter((trip) => !trip.deletedAt);
  const activePlaces = visible.places.filter((place) => !place.deletedAt);
  const activeTripIds = new Set(activeTrips.map((trip) => trip.id));
  const activePlaceIds = new Set(activePlaces.map((place) => place.id));

  const targetPageId = options.targetPageId;
  const pageTripIds = targetPageId
    ? [
        ...new Set(
          visible.tripPageLinks
            .filter((link) => link.pageId === targetPageId && activeTripIds.has(link.tripId))
            .map((link) => link.tripId)
        )
      ]
    : [];
  const pagePlaceIds = targetPageId
    ? [
        ...new Set(
          visible.pagePlaceLinks
            .filter((link) => link.pageId === targetPageId && activePlaceIds.has(link.placeId))
            .map((link) => link.placeId)
        )
      ]
    : [];

  const inspection = inspectTripStore(rawStore);
  const damage =
    inspection.issues.length > 0
      ? `检测到 ${inspection.issues.length} 条旅行/地点记录异常（已原样保留，未自动清理）：` +
        inspection.issues
          .slice(0, 3)
          .map((issue) => `${issue.store}[${issue.index}]`)
          .join("、")
      : undefined;

  const now = () => optionsRef.current.now ?? (() => new Date());

  const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

  /**
   * 统一命令执行。
   *
   * 身份规则（R3）：
   * - 消息（message/onNotice）与 busy 只属于**当前**会话（篇/启用状态/opId 任一变化即作废）；
   * - 已提交的档案事实必须回读——回读是**身份无关的全局刷新**，否则切篇后新会话会停留在旧档案；
   * - 回读失败与提交失败分开报告，不把“已提交但没刷新”误报成“完全没保存”。
   */
  async function run(command: TripCommand, successMessage: string, toast = true): Promise<void> {
    const opId = (opIdRef.current += 1);
    // 发起时的代际：任何一次目标/启用切换都会让它失效（不可逆）。
    const sessionAtStart = sessionRef.current;
    const started = optionsRef.current;
    const identity = { pageId: started.targetPageId, enabled: started.enabled };
    const isCurrentOp = () =>
      opIdRef.current === opId &&
      sessionRef.current === sessionAtStart &&
      optionsRef.current.targetPageId === identity.pageId &&
      optionsRef.current.enabled === identity.enabled;

    setBusy(true);
    try {
      const outcome = await commitTripCommand(started.repository, command, {
        expectedRevision: started.archive.revision,
        now: now()
      });
      if (outcome.status === "conflict" || outcome.status === "no-op") {
        if (!isCurrentOp()) return;
        setMessage(
          outcome.status === "conflict"
            ? `${outcome.detail}（${outcome.code}）`
            : "没有变化（相同内容或目标已处理）。"
        );
        return;
      }
      try {
        await optionsRef.current.onReloadArchive?.();
      } catch (error) {
        if (!isCurrentOp()) return;
        setMessage(
          `已提交到档案，但界面刷新失败：${describe(error)}（提交已生效，可刷新页面查看）`
        );
        return;
      }
      if (!isCurrentOp()) return;
      setMessage(successMessage);
      if (toast) optionsRef.current.onNotice?.(successMessage);
    } catch (error) {
      if (!isCurrentOp()) return;
      setMessage(`保存失败：${describe(error)}`);
    } finally {
      if (isCurrentOp()) setBusy(false);
    }
  }

  const nextId = (prefix: string) => (optionsRef.current.createId ?? defaultTripId)(prefix);

  const requireTarget = (): string | null => {
    if (!optionsRef.current.enabled) {
      setMessage("旅行与地点面板未启用。");
      return null;
    }
    if (!optionsRef.current.targetPageId) {
      setMessage("先在编辑区打开一篇笔记本，再关联行程或地点。");
      return null;
    }
    return optionsRef.current.targetPageId;
  };

  const coordinateGuard = (draft: PlaceDraft) => {
    const parsed = parseCoordinates(draft.latitude, draft.longitude);
    if (!parsed.ok) {
      setMessage(parsed.detail);
      return null;
    }
    return parsed.value;
  };

  return {
    trips: visible.trips,
    places: visible.places,
    deletedTrips: visible.trips.filter((trip) => trip.deletedAt),
    deletedPlaces: visible.places.filter((place) => place.deletedAt),
    pageTripIds,
    pagePlaceIds,
    damage,
    busy,
    message,
    createTrip: (draft) =>
      run(
        {
          kind: "create-trip",
          id: nextId("trip"),
          title: draft.title,
          startDate: draft.startDate.trim() === "" ? null : draft.startDate.trim(),
          endDate: draft.endDate.trim() === "" ? null : draft.endDate.trim()
        },
        "已新建旅行。"
      ),
    updateTrip: (id, draft) =>
      run(
        {
          kind: "update-trip",
          id,
          title: draft.title,
          startDate: draft.startDate.trim() === "" ? null : draft.startDate.trim(),
          endDate: draft.endDate.trim() === "" ? null : draft.endDate.trim()
        },
        "已更新旅行。"
      ),
    deleteTrip: (id) => run({ kind: "soft-delete-trip", id }, "已把旅行移入垃圾桶（可恢复）。"),
    restoreTrip: (id) => run({ kind: "restore-trip", id }, "已恢复旅行。"),
    purgeTrip: (id) => run({ kind: "purge-trip", id }, "已永久删除旅行及其关联。"),
    createPlace: async (draft) => {
      const coordinates = coordinateGuard(draft);
      // `null` = 解析失败（消息已设置）；`undefined` = 两个都留空 = 坐标未知。
      if (coordinates === null) return;
      await run(
        {
          kind: "create-place",
          id: nextId("place"),
          name: draft.name,
          ...(coordinates ? { coordinates } : {}),
          ...(draft.address.trim() ? { address: draft.address.trim() } : {})
        },
        "已新建地点。"
      );
    },
    updatePlace: async (id, draft) => {
      const coordinates = coordinateGuard(draft);
      if (coordinates === null) return;
      await run(
        {
          kind: "update-place",
          id,
          name: draft.name,
          coordinates: coordinates ?? null,
          address: draft.address.trim() ? draft.address.trim() : null
        },
        "已更新地点。"
      );
    },
    deletePlace: (id) => run({ kind: "soft-delete-place", id }, "已把地点移入垃圾桶（可恢复）。"),
    restorePlace: (id) => run({ kind: "restore-place", id }, "已恢复地点。"),
    purgePlace: (id) => run({ kind: "purge-place", id }, "已永久删除地点及其关联。"),
    linkTripToPage: async (tripId) => {
      const pageId = requireTarget();
      if (!pageId) return;
      await run({ kind: "link-trip-page", tripId, pageId }, "已把这一篇关联到旅行。");
    },
    unlinkTripFromPage: async (tripId) => {
      const pageId = requireTarget();
      if (!pageId) return;
      await run({ kind: "unlink-trip-page", tripId, pageId }, "已解除这一篇与旅行的关联。");
    },
    linkPlaceToPage: async (placeId) => {
      const pageId = requireTarget();
      if (!pageId) return;
      // 用户手动关联 → source 固定为 user（绝不把 AI 候选伪装成用户事实，反之亦然）。
      await run(
        { kind: "link-page-place", pageId, placeId, source: "user" },
        "已把这一篇关联到地点。"
      );
    },
    unlinkPlaceFromPage: async (placeId, source) => {
      const pageId = requireTarget();
      if (!pageId) return;
      await run(
        { kind: "unlink-page-place", pageId, placeId, source },
        "已解除这一篇与该地点的关联。"
      );
    }
  };
}
