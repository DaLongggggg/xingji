"use client";

/**
 * P6-03：旅行与地点面板（纯展示 + 表单，不含任何 AI 调用）。
 *
 * 边界：
 * - 手动管理：新建/编辑/软删/恢复/永久删除旅行与地点；把**当前篇**关联到旅行/地点并可解除；
 * - 未知日期显示“日期未知”、未知坐标显示“坐标未知”（合法 (0,0) 如实显示为 0.0000, 0.0000）；
 * - 冲突/失败由 hook 的 message 与 busy 呈现，不静默；
 * - 不新增顶层入口（挂在现有笔记编辑区内），不做 AI/EXIF 候选或地图供应商接入。
 */
import { useState } from "react";
import { ChevronRight, MapPin, Trash2, X } from "lucide-react";
import type { Place, Trip } from "./trip-model";
import type { PlaceDraft, TripPlaceDraft, UseTripsApi } from "./use-trips";

export type TripPanelProps = {
  trips: UseTripsApi;
  /** 当前编辑篇的标题；null 表示没有可关联的篇。 */
  pageTitle: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onDismiss: () => void;
};

const EMPTY_TRIP: TripPlaceDraft = { title: "", startDate: "", endDate: "" };
const EMPTY_PLACE: PlaceDraft = { name: "", latitude: "", longitude: "", address: "" };

function tripDates(trip: Trip): string {
  if (!trip.startDate && !trip.endDate) return "日期未知";
  return `${trip.startDate ?? "未知"} → ${trip.endDate ?? "未知"}`;
}

function placeCoordinates(place: Place): string {
  if (!place.coordinates) return "坐标未知";
  return `${place.coordinates.latitude.toFixed(4)}, ${place.coordinates.longitude.toFixed(4)}`;
}

export function TripPanel({ trips, pageTitle, collapsed, onToggleCollapsed, onDismiss }: TripPanelProps) {
  const [tripDraft, setTripDraft] = useState<TripPlaceDraft>(EMPTY_TRIP);
  const [placeDraft, setPlaceDraft] = useState<PlaceDraft>(EMPTY_PLACE);
  const [editingTripId, setEditingTripId] = useState<string>();
  const [editingPlaceId, setEditingPlaceId] = useState<string>();

  const activeTrips = trips.trips.filter((trip) => !trip.deletedAt);
  const activePlaces = trips.places.filter((place) => !place.deletedAt);

  const startEditTrip = (trip: Trip) => {
    setEditingTripId(trip.id);
    setTripDraft({
      title: trip.title,
      startDate: trip.startDate ?? "",
      endDate: trip.endDate ?? ""
    });
  };

  const startEditPlace = (place: Place) => {
    setEditingPlaceId(place.id);
    setPlaceDraft({
      name: place.name,
      latitude: place.coordinates ? String(place.coordinates.latitude) : "",
      longitude: place.coordinates ? String(place.coordinates.longitude) : "",
      address: place.address ?? ""
    });
  };

  const submitTrip = async () => {
    if (editingTripId) {
      await trips.updateTrip(editingTripId, tripDraft);
      setEditingTripId(undefined);
    } else {
      await trips.createTrip(tripDraft);
    }
    setTripDraft(EMPTY_TRIP);
  };

  const submitPlace = async () => {
    if (editingPlaceId) {
      await trips.updatePlace(editingPlaceId, placeDraft);
      setEditingPlaceId(undefined);
    } else {
      await trips.createPlace(placeDraft);
    }
    setPlaceDraft(EMPTY_PLACE);
  };

  return (
    <section className="nb-trips" aria-label="旅行与地点" data-busy={trips.busy ? "true" : "false"}>
      <header className="nb-trips-head">
        <button
          type="button"
          className="nb-trips-toggle"
          aria-expanded={!collapsed}
          data-testid="trips-toggle"
          onClick={onToggleCollapsed}
        >
          <MapPin size={15} aria-hidden />
          <span>旅行与地点</span>
          <span className="nb-trips-headline">
            {activeTrips.length} 趟旅行 · {activePlaces.length} 个地点
          </span>
          <ChevronRight
            size={15}
            aria-hidden
            className={collapsed ? "nb-trips-chevron" : "nb-trips-chevron is-open"}
          />
        </button>
        {collapsed ? null : (
          <button
            type="button"
            className="nb-icon-button"
            aria-label="关闭旅行与地点面板"
            title="关闭"
            onClick={onDismiss}
          >
            <X size={15} />
          </button>
        )}
      </header>

      {collapsed ? null : (
        <div className="nb-trips-body">
          {trips.damage ? (
            <p className="nb-trips-warn" role="status" data-testid="trips-damage">
              {trips.damage}
            </p>
          ) : null}
          {trips.message ? (
            <p className="nb-trips-message" role="status" aria-live="polite" data-testid="trips-message">
              {trips.message}
            </p>
          ) : null}
          <p className="nb-trips-note">
            当前篇：{pageTitle ?? "（未打开篇）"}。旅行表示现实中发生的一次出行，与笔记本不是一回事；
            地点是真实 POI，地区（省/市）是行政区，两者分开。
          </p>

          <section className="nb-trips-section">
            <h4>旅行</h4>
            <ul className="nb-trips-list" data-testid="trip-list">
              {activeTrips.length === 0 ? <li className="nb-trips-note">还没有旅行。</li> : null}
              {activeTrips.map((trip) => {
                const linked = trips.pageTripIds.includes(trip.id);
                return (
                  <li key={trip.id} className="nb-trips-item">
                    <span className="nb-trips-title">{trip.title}</span>
                    <span className="nb-trips-meta">{tripDates(trip)}</span>
                    <span className="nb-trips-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={!pageTitle || trips.busy}
                        aria-pressed={linked}
                        onClick={() =>
                          linked ? trips.unlinkTripFromPage(trip.id) : trips.linkTripToPage(trip.id)
                        }
                      >
                        {linked ? "解除本篇关联" : "关联本篇"}
                      </button>
                      <button type="button" className="secondary-button" onClick={() => startEditTrip(trip)}>
                        编辑
                      </button>
                      <button type="button" className="secondary-button" onClick={() => trips.deleteTrip(trip.id)}>
                        删除
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>

            <div className="nb-trips-form">
              <label>
                <span>标题</span>
                <input
                  type="text"
                  aria-label={editingTripId ? "编辑旅行标题" : "新旅行标题"}
                  value={tripDraft.title}
                  onChange={(event) => setTripDraft({ ...tripDraft, title: event.target.value })}
                />
              </label>
              <label>
                <span>起始（当地日历）</span>
                <input
                  type="date"
                  aria-label={editingTripId ? "编辑旅行起始" : "新旅行起始"}
                  value={tripDraft.startDate}
                  onChange={(event) => setTripDraft({ ...tripDraft, startDate: event.target.value })}
                />
              </label>
              <label>
                <span>结束</span>
                <input
                  type="date"
                  aria-label={editingTripId ? "编辑旅行结束" : "新旅行结束"}
                  value={tripDraft.endDate}
                  onChange={(event) => setTripDraft({ ...tripDraft, endDate: event.target.value })}
                />
              </label>
              <button
                type="button"
                className="primary-button"
                disabled={trips.busy || tripDraft.title.trim() === ""}
                onClick={() => void submitTrip()}
              >
                {editingTripId ? "保存旅行" : "新建旅行"}
              </button>
              {editingTripId ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    setEditingTripId(undefined);
                    setTripDraft(EMPTY_TRIP);
                  }}
                >
                  取消编辑
                </button>
              ) : null}
            </div>

            {trips.deletedTrips.length > 0 ? (
              <ul className="nb-trips-trash" data-testid="trip-trash">
                {trips.deletedTrips.map((trip) => (
                  <li key={trip.id}>
                    <span>垃圾桶：{trip.title}</span>
                    <button type="button" className="secondary-button" onClick={() => trips.restoreTrip(trip.id)}>
                      恢复
                    </button>
                    <button
                      type="button"
                      className="secondary-button nb-icon-danger"
                      aria-label={`永久删除旅行 ${trip.title}`}
                      onClick={() => trips.purgeTrip(trip.id)}
                    >
                      <Trash2 size={14} aria-hidden /> 永久删除
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section className="nb-trips-section">
            <h4>地点</h4>
            <ul className="nb-trips-list" data-testid="place-list">
              {activePlaces.length === 0 ? <li className="nb-trips-note">还没有地点。</li> : null}
              {activePlaces.map((place) => {
                const linked = trips.pagePlaceIds.includes(place.id);
                return (
                  <li key={place.id} className="nb-trips-item">
                    <span className="nb-trips-title">{place.name}</span>
                    <span className="nb-trips-meta">{placeCoordinates(place)}</span>
                    <span className="nb-trips-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={!pageTitle || trips.busy}
                        aria-pressed={linked}
                        onClick={() =>
                          linked
                            ? trips.unlinkPlaceFromPage(place.id, "user")
                            : trips.linkPlaceToPage(place.id)
                        }
                      >
                        {linked ? "解除本篇关联" : "关联本篇"}
                      </button>
                      <button type="button" className="secondary-button" onClick={() => startEditPlace(place)}>
                        编辑
                      </button>
                      <button type="button" className="secondary-button" onClick={() => trips.deletePlace(place.id)}>
                        删除
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>

            <div className="nb-trips-form">
              <label>
                <span>名称</span>
                <input
                  type="text"
                  aria-label={editingPlaceId ? "编辑地点名称" : "新地点名称"}
                  value={placeDraft.name}
                  onChange={(event) => setPlaceDraft({ ...placeDraft, name: event.target.value })}
                />
              </label>
              <label>
                <span>纬度（可留空）</span>
                <input
                  type="text"
                  inputMode="decimal"
                  aria-label={editingPlaceId ? "编辑地点纬度" : "新地点纬度"}
                  value={placeDraft.latitude}
                  onChange={(event) => setPlaceDraft({ ...placeDraft, latitude: event.target.value })}
                />
              </label>
              <label>
                <span>经度（可留空）</span>
                <input
                  type="text"
                  inputMode="decimal"
                  aria-label={editingPlaceId ? "编辑地点经度" : "新地点经度"}
                  value={placeDraft.longitude}
                  onChange={(event) => setPlaceDraft({ ...placeDraft, longitude: event.target.value })}
                />
              </label>
              <label>
                <span>地址（可留空）</span>
                <input
                  type="text"
                  aria-label={editingPlaceId ? "编辑地点地址" : "新地点地址"}
                  value={placeDraft.address}
                  onChange={(event) => setPlaceDraft({ ...placeDraft, address: event.target.value })}
                />
              </label>
              <button
                type="button"
                className="primary-button"
                disabled={trips.busy || placeDraft.name.trim() === ""}
                onClick={() => void submitPlace()}
              >
                {editingPlaceId ? "保存地点" : "新建地点"}
              </button>
              {editingPlaceId ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    setEditingPlaceId(undefined);
                    setPlaceDraft(EMPTY_PLACE);
                  }}
                >
                  取消编辑
                </button>
              ) : null}
            </div>

            {trips.deletedPlaces.length > 0 ? (
              <ul className="nb-trips-trash" data-testid="place-trash">
                {trips.deletedPlaces.map((place) => (
                  <li key={place.id}>
                    <span>垃圾桶：{place.name}</span>
                    <button type="button" className="secondary-button" onClick={() => trips.restorePlace(place.id)}>
                      恢复
                    </button>
                    <button
                      type="button"
                      className="secondary-button nb-icon-danger"
                      aria-label={`永久删除地点 ${place.name}`}
                      onClick={() => trips.purgePlace(place.id)}
                    >
                      <Trash2 size={14} aria-hidden /> 永久删除
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        </div>
      )}
    </section>
  );
}
