/** 主工作区壁纸层：只覆盖终端/对话主区，不污染侧栏和功能页。 */
import type { CSSProperties } from "react";
import { useSettingsStore, DEFAULT_WALLPAPER } from "../../store/settingsStore";
import type { WallpaperFit } from "../../api/types";

const FIT_STYLES: Record<WallpaperFit, CSSProperties> = {
  cover: {
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
    backgroundSize: "cover",
  },
  contain: {
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
    backgroundSize: "contain",
  },
  tile: {
    backgroundPosition: "top left",
    backgroundRepeat: "repeat",
    backgroundSize: "auto",
  },
  center: {
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
    backgroundSize: "auto",
  },
};

export function MainWallpaperLayer(): React.JSX.Element | null {
  const wallpaper = useSettingsStore(
    (state) => state.config?.wallpaper ?? DEFAULT_WALLPAPER,
  );
  const asset = wallpaper.dataUrl ?? wallpaper.file ?? null;
  if (!wallpaper.enabled || wallpaper.kind !== "image" || !asset) return null;

  const blur = Math.max(0, wallpaper.blur);

  return (
    <div className="wallpaper-layer" aria-hidden="true">
      <div
        className="wallpaper-media"
        style={{
          backgroundImage: `url("${asset.replace(/\"/g, "%22")}")`,
          filter: blur > 0 ? `blur(${blur}px)` : undefined,
          opacity: wallpaper.opacity,
          transform: blur > 0 ? "scale(1.06)" : undefined,
          ...FIT_STYLES[wallpaper.fit],
        }}
      />
      {wallpaper.dim > 0 && (
        <div className="wallpaper-dim" style={{ opacity: wallpaper.dim }} />
      )}
    </div>
  );
}
