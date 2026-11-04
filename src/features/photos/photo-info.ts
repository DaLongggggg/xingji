/**
 * 照片信息的只读入口：只接收本地字节，不接受 URL、不重编码、不写存储。
 * 容器与 EXIF/XMP 解析交给 ExifReader；这里仅归一化应用所需字段。
 * 元数据是文件自述，并不证明拍摄地点/时间真实；缺失时不能推测时区或设备。
 */
import { load, type ExpandedTags } from "exifreader";

export type PhotoFormat = "jpeg" | "png" | "webp" | "heic" | "heif";
export type PhotoGps = { lat: number; lng: number; datum: string | null };
export type PhotoInfo = {
  status: "ready" | "unsupported" | "unreadable";
  format: PhotoFormat | null;
  mime: string | null;
  bytes: number;
  /** 文件像素尺寸；方向另列，不在这里旋转或改变像素。 */
  width: number | null;
  height: number | null;
  bitDepth: number | null;
  gps: PhotoGps | null;
  /** 保留原始拍摄时间；offset 缺失表示时区未知，不转成猜测的 UTC 时间。 */
  capturedAt: { value: string; offset: string | null; source: "EXIF" | "XMP" } | null;
  orientation: number | null;
  /** GPSImgDirection，真北/磁北基准不混同于 EXIF 显示方向。 */
  heading: { degrees: number; reference: "true" | "magnetic" } | null;
  device: { make: string | null; model: string | null; lens: string | null };
};

type Tags = Record<string, unknown>;
const MIME: Record<PhotoFormat, string> = {
  jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif"
};

// 格式识别只用于给出失败/不支持状态；实际容器和标签解析均由依赖完成。
function identify(bytes: Uint8Array): PhotoFormat | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 8) === "PNG\r\n\x1a\n") return "png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (ascii(4, 8) === "ftyp") {
    const major = ascii(8, 12);
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"].includes(major)) return "heic";
    if (major === "mif1" || major === "msf1") return "heif";
  }
  return null;
}

/**
 * ExifReader 宽容读取损坏的 APP 段；业务不接受损坏的段封装用于定位。
 * 这里只检查 JPEG 段封装，既不识别 EXIF 标签也不解析像素/熵编码。
 */
function validJpegHeaders(bytes: Uint8Array): boolean {
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) return true;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (!marker || offset + 2 > bytes.length) return false;
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return false;
    if (marker === 0xda) return true; // 扫描数据交给图像解码器，不扫描像素中的 FF 字节。
    offset += length;
  }
  return false;
}

function tagValue(tags: Tags | undefined, key: string): unknown {
  const tag = tags?.[key];
  if (!tag || typeof tag !== "object") return undefined;
  // computed 是库对有理数等的数值换算；零分母得到 null，不能 Number(null) 变成 0。
  return "computed" in tag ? tag.computed : "value" in tag ? tag.value : undefined;
}
function text(value: unknown): string | null {
  const scalar = Array.isArray(value) && value.length === 1 ? value[0] : value;
  return typeof scalar === "string" ? scalar.replace(/\0/g, "").trim().slice(0, 256) || null : null;
}
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function positive(value: unknown): number | null {
  const parsed = number(value);
  return parsed !== null && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
function decimalDegrees(value: unknown): number | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const parts = value.map(number);
  if (parts.some(part => part === null)) return null;
  const [degrees, minutes, seconds] = parts as number[];
  if (degrees < 0 || minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) return null;
  return degrees + minutes / 60 + seconds / 3600;
}
function gpsOf(exif: Tags | undefined): PhotoGps | null {
  const lat = decimalDegrees(tagValue(exif, "GPSLatitude"));
  const lng = decimalDegrees(tagValue(exif, "GPSLongitude"));
  const latRef = text(tagValue(exif, "GPSLatitudeRef"));
  const lngRef = text(tagValue(exif, "GPSLongitudeRef"));
  if (lat === null || lng === null || lat > 90 || lng > 180 ||
    (latRef !== "N" && latRef !== "S") || (lngRef !== "E" && lngRef !== "W")) return null;
  return { lat: latRef === "S" ? -lat : lat, lng: lngRef === "W" ? -lng : lng,
    datum: text(tagValue(exif, "GPSMapDatum")) };
}

function captureTime(tags: ExpandedTags): PhotoInfo["capturedAt"] {
  const exif = tags.exif as Tags | undefined;
  const date = text(tagValue(exif, "DateTimeOriginal"));
  if (date && /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(date)) {
    const rawOffset = text(tagValue(exif, "OffsetTimeOriginal"));
    const offset = rawOffset && /^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(rawOffset) ? rawOffset : null;
    return { value: date, offset, source: "EXIF" };
  }
  const xmp = tags.xmp as Tags | undefined;
  const xmpDate = text(tagValue(xmp, "DateTimeOriginal")) ?? text(tagValue(xmp, "CreateDate"));
  if (xmpDate && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(xmpDate))
    return { value: xmpDate, offset: /(?:Z|[+-]\d{2}:\d{2})$/.exec(xmpDate)?.[0] ?? null, source: "XMP" };
  return null;
}

/** 所有消费方使用同一份归一化结果；解析失败不影响原件保存/下载。 */
export async function readPhotoInfo(input: Blob | Uint8Array | ArrayBuffer): Promise<PhotoInfo> {
  let bytes: Uint8Array;
  try {
    bytes = input instanceof Uint8Array ? input : new Uint8Array(input instanceof ArrayBuffer ? input : await input.arrayBuffer());
  } catch {
    return emptyInfo(null, input instanceof Blob ? input.size : 0, "unreadable");
  }
  const format = identify(bytes);
  const result = emptyInfo(format, bytes.byteLength, format ? "unreadable" : "unsupported");
  if (!format || bytes.byteLength > 64 * 1024 ** 2 || (format === "jpeg" && !validJpegHeaders(bytes))) return result;
  try {
    // 不取 MakerNotes、缩略图、完整 ICC 等无关内容，避免把原始标签全集交给 UI/Agent。
    const tags = load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
      expanded: true, computed: true,
      includeTags: {
        file: ["FileType", "Image Width", "Image Height", "Bits Per Sample"],
        png: ["Image Width", "Image Height", "Bit Depth"], riff: ["ImageWidth", "ImageHeight"],
        exif: ["ImageWidth", "ImageLength", "PixelXDimension", "PixelYDimension", "Orientation", "Make", "Model", "LensModel",
          "DateTimeOriginal", "OffsetTimeOriginal", "GPSLatitude", "GPSLatitudeRef", "GPSLongitude", "GPSLongitudeRef",
          "GPSMapDatum", "GPSImgDirection", "GPSImgDirectionRef"],
        xmp: ["DateTimeOriginal", "CreateDate", "Make", "Model", "LensModel"]
      }
    });
    const exif = tags.exif as Tags | undefined;
    const xmp = tags.xmp as Tags | undefined;
    const width = positive(tagValue(tags.file as Tags, "Image Width")) ?? positive(tagValue(tags.png as Tags, "Image Width")) ??
      positive(tagValue(tags.riff as Tags, "ImageWidth")) ?? positive(tagValue(exif, "PixelXDimension")) ?? positive(tagValue(exif, "ImageWidth"));
    const height = positive(tagValue(tags.file as Tags, "Image Height")) ?? positive(tagValue(tags.png as Tags, "Image Height")) ??
      positive(tagValue(tags.riff as Tags, "ImageHeight")) ?? positive(tagValue(exif, "PixelYDimension")) ?? positive(tagValue(exif, "ImageLength"));
    const orientation = number(tagValue(exif, "Orientation"));
    const degrees = number(tagValue(exif, "GPSImgDirection"));
    const reference = text(tagValue(exif, "GPSImgDirectionRef"));
    return { ...result, status: "ready", width, height,
      bitDepth: positive(tagValue(tags.png as Tags, "Bit Depth")) ?? positive(tagValue(tags.file as Tags, "Bits Per Sample")),
      gps: gpsOf(exif), capturedAt: captureTime(tags),
      orientation: orientation !== null && Number.isInteger(orientation) && orientation >= 1 && orientation <= 8 ? orientation : null,
      heading: degrees !== null && degrees >= 0 && degrees < 360 && (reference === "T" || reference === "M")
        ? { degrees, reference: reference === "T" ? "true" : "magnetic" } : null,
      device: { make: text(tagValue(exif, "Make")) ?? text(tagValue(xmp, "Make")),
        model: text(tagValue(exif, "Model")) ?? text(tagValue(xmp, "Model")),
        lens: text(tagValue(exif, "LensModel")) ?? text(tagValue(xmp, "LensModel")) }
    };
  } catch {
    return result;
  }
}

function emptyInfo(format: PhotoFormat | null, bytes: number, status: PhotoInfo["status"]): PhotoInfo {
  return { status, format, mime: format ? MIME[format] : null, bytes, width: null, height: null, bitDepth: null,
    gps: null, capturedAt: null, orientation: null, heading: null, device: { make: null, model: null, lens: null } };
}
