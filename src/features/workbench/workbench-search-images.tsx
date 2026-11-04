"use client";

import { useState } from "react";
import { searchImageIdentity, uniqueSearchImages, type WorkbenchSearchImage } from "./workbench-media-projection";

export { messageSearchImages } from "./workbench-media-projection";
export type { WorkbenchSearchImage } from "./workbench-media-projection";
export type PreviewSearchImage = (image: WorkbenchSearchImage, trigger: HTMLButtonElement, images: WorkbenchSearchImage[]) => void;

function SearchImageCard({ image, images, onPreview }: {
  image: WorkbenchSearchImage; images: WorkbenchSearchImage[]; onPreview: PreviewSearchImage;
}) {
  const [failedSource, setFailedSource] = useState<string>();
  const src = failedSource === image.thumbnailUrl ? image.url : image.thumbnailUrl ?? image.url;
  const failed = failedSource === image.url;
  const title = image.title.trim() || "搜索图片";
  return <span className="wb-search-image-card" data-unavailable={failed || undefined}>
    <button type="button" className="wb-search-image-preview"
      title={title} aria-label={`放大搜索图片：${title}`} onClick={event => onPreview(image, event.currentTarget, images)}>
      {failed ? <span className="wb-search-image-unavailable">图片暂不可用</span>
        : (
          // 外部预览保持真实地址，不请求图片优化代理。
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={title} loading="lazy" decoding="async" referrerPolicy="no-referrer"
            onLoad={event => {
              const loaded = event.currentTarget;
              // 极小的供应商缩略图常是图标；尝试实际原文件，不据尺寸删除原图。
              if (src === image.thumbnailUrl && src !== image.url
                && loaded.naturalWidth > 0 && loaded.naturalWidth <= 96
                && loaded.naturalHeight > 0 && loaded.naturalHeight <= 96) setFailedSource(src);
            }}
            onError={() => setFailedSource(src)} />
        )}
    </button>
    {failed ? <a className="wb-search-image-source" href={image.sourceUrl} target="_blank" rel="noopener noreferrer">查看来源：{title}</a> : null}
  </span>;
}

export function WorkbenchSearchImages({ images, onPreview, inline = false }: {
  images: WorkbenchSearchImage[]; onPreview: PreviewSearchImage; inline?: boolean;
}) {
  if (!images.length) return null;
  const unique = uniqueSearchImages(images);
  const cards = unique.map(image => <SearchImageCard key={searchImageIdentity(image)}
    image={image} images={unique} onPreview={onPreview} />);
  return inline ? <span className="wb-inline-search-image">{cards}</span>
    : <div className="wb-search-images" aria-label="搜索图片">{cards}</div>;
}
