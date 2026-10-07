"use client";

import Image from "next/image";
import { useSyncExternalStore, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// The Athens Voice key visual (16:9), shown whole in every view: it is never
// cropped, only scaled, with its own blurred glow filling the rest
const PHOTO = "/athens-voice.jpg";
const PHOTO_ALT = "Athens Voice: Πιαστείτε στα χέρια, και ακούστε τη μουσική που δημιουργεί το συναίσθημά σας";
const MOVE = "1.6s cubic-bezier(0.65, 0, 0.35, 1)";

// Where the picture and the waves sit, in % of the screen
export interface Layout {
  photo: {
    top: number;
    height: number;
    card: boolean; // a framed, glowing card rather than edge to edge
    dim: number; // brightness, under waves drawn over it
    fade: boolean; // its foot melts into the waves below
    soft: boolean; // its sides melt into its glow
    above: boolean; // in front of the waves
  };
  ambient: number; // the picture's blurred glow behind it, 0-1
  waves: {
    top: number;
    bottom: number;
    side: number;
    glow: boolean; // drawn as light over the picture
    fade: boolean; // their top melts into the picture above
  };
  // A second set of waves (Frame): its own top and bottom
  second?: { top: number; bottom: number };
}

const STACK: Layout = {
  photo: { top: 0, height: 80, card: false, dim: 1, fade: true, soft: true, above: false },
  ambient: 0.6,
  waves: { top: 66, bottom: 0, side: 0, glow: false, fade: true },
};
const OVERLAY: Layout = {
  photo: { top: 0, height: 100, card: false, dim: 0.78, fade: false, soft: false, above: false },
  ambient: 0.6,
  waves: { top: 0, bottom: 0, side: 0, glow: true, fade: false },
};
const CARD: Layout = {
  photo: { top: 4, height: 54, card: true, dim: 1, fade: false, soft: false, above: true },
  ambient: 0,
  waves: { top: 40, bottom: 0, side: 0, glow: false, fade: false },
};
// The live waves laid over the poster's own, between its hearts
const POSTER: Layout = {
  photo: { top: 0, height: 100, card: false, dim: 1, fade: false, soft: false, above: false },
  ambient: 0.6,
  waves: { top: 21, bottom: 34, side: 14, glow: true, fade: false },
};
// The picture between the two hearts: a set of waves on each edge of it, the
// red rising from its top and the blue hanging from its bottom (the picture
// hides the other half of each)
const FRAME: Layout = {
  photo: { top: 18, height: 64, card: true, dim: 1, fade: false, soft: false, above: true },
  ambient: 0,
  waves: { top: 0, bottom: 64, side: 0, glow: false, fade: false },
  second: { top: 64, bottom: 0 },
};
// Whatever the view, the song's note gets the stage, under the picture
export const SONG_LAYOUT: Layout = {
  photo: { top: 4, height: 34, card: true, dim: 1, fade: false, soft: false, above: true },
  ambient: 0,
  waves: { top: 30, bottom: 0, side: 0, glow: false, fade: false },
};

export const VIEWS = [
  { name: "Stack", hint: "The picture above, the waves below", layout: STACK },
  { name: "Overlay", hint: "The waves drawn in light over the whole picture", layout: OVERLAY },
  { name: "Card", hint: "The waves on their own backdrop, the picture as a card", layout: CARD },
  { name: "Poster", hint: "The live waves over the poster's own", layout: POSTER },
  { name: "Frame", hint: "The red wave above the picture, the blue below", layout: FRAME },
] as const;

// The chosen view: ?view=N, else the last one chosen in this browser
const VIEW_KEY = "musical-box-syncwave-view";
const viewListeners = new Set<() => void>();
const inRange = (value: number) => Number.isInteger(value) && value >= 1 && value <= VIEWS.length;
function readView(): number {
  const fromUrl = Number(new URLSearchParams(window.location.search).get("view"));
  if (inRange(fromUrl)) return fromUrl;
  try {
    const saved = Number(localStorage.getItem(VIEW_KEY));
    if (inRange(saved)) return saved;
  } catch {
    // storage unavailable: the URL keeps it
  }
  return 1;
}
function chooseView(view: number) {
  try {
    localStorage.setItem(VIEW_KEY, String(view));
  } catch {
    // storage unavailable: the URL keeps it
  }
  const url = new URL(window.location.href);
  url.searchParams.set("view", String(view));
  window.history.replaceState(null, "", url);
  for (const listener of viewListeners) listener();
}
function subscribeView(listener: () => void) {
  viewListeners.add(listener);
  return () => {
    viewListeners.delete(listener);
  };
}
export const useView = () => useSyncExternalStore(subscribeView, readView, () => 1);

/** The five views, like the theme switch: shown while the mouse moves. */
export function ViewPicker({ view, visible }: { view: number; visible: boolean }) {
  return (
    <div
      role="radiogroup"
      aria-label="View"
      onDoubleClick={(event) => event.stopPropagation()}
      className={cn(
        "absolute top-[3vh] left-[3vw] z-10 inline-flex items-center gap-0.5 rounded-full border border-border/60 bg-card p-1 transition-opacity duration-500",
        visible ? "opacity-100" : "pointer-events-none opacity-0"
      )}
    >
      {VIEWS.map(({ name, hint }, i) => (
        <button
          key={name}
          type="button"
          role="radio"
          aria-checked={view === i + 1}
          title={hint}
          onClick={() => chooseView(i + 1)}
          className={cn(
            "h-8 rounded-full px-3 text-xs font-medium transition-colors",
            view === i + 1
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          )}
        >
          {i + 1} · {name}
        </button>
      ))}
    </div>
  );
}

/** The picture, whole: edge to edge or as a card, with its glow behind. */
export function Photo({ layout }: { layout: Layout }) {
  const { photo, ambient } = layout;
  const masks = [
    photo.fade && "linear-gradient(to bottom, #000 84%, transparent)",
    photo.soft && "linear-gradient(to right, transparent, #000 4%, #000 96%, transparent)",
  ].filter(Boolean);
  const mask = masks.length ? masks.join(", ") : "none";
  return (
    <>
      <div aria-hidden className="absolute inset-0" style={{ opacity: ambient, transition: `opacity ${MOVE}` }}>
        <Image
          src={PHOTO}
          alt=""
          fill
          sizes="25vw"
          priority
          className="object-cover"
          style={{ filter: "blur(3vw) brightness(0.45) saturate(1.3)", transform: "scale(1.15)" }}
        />
      </div>
      <div
        className="absolute left-1/2 overflow-hidden"
        style={{
          top: `${photo.top}%`,
          height: `${photo.height}%`,
          aspectRatio: "16 / 9",
          maxWidth: "100%",
          transform: "translateX(-50%)",
          zIndex: photo.above ? 3 : 1,
          borderRadius: photo.card ? "1.4vw" : "0",
          boxShadow: photo.card ? "0 0 3vw hsl(322 95% 62% / 0.3), 0 1.6vw 4vw rgb(0 0 0 / 0.55)" : "none",
          maskImage: mask,
          WebkitMaskImage: mask,
          maskComposite: "intersect",
          WebkitMaskComposite: "source-in",
          transition: `top ${MOVE}, height ${MOVE}, border-radius ${MOVE}, box-shadow ${MOVE}`,
        }}
      >
        <Image
          src={PHOTO}
          alt={PHOTO_ALT}
          fill
          sizes="100vw"
          priority
          className="object-contain"
          style={{ filter: `brightness(${photo.dim})`, transition: `filter ${MOVE}` }}
        />
      </div>
    </>
  );
}

/** Where the waves are drawn; they resize as the view changes. */
export function WavesFrame({ layout, second = false, children }: { layout: Layout; second?: boolean; children: ReactNode }) {
  const waves = second && layout.second ? { ...layout.waves, ...layout.second } : layout.waves;
  const mask = waves.fade ? "linear-gradient(to bottom, transparent, #000 30%)" : "none";
  return (
    <div
      className="absolute"
      style={{
        top: `${waves.top}%`,
        bottom: `${waves.bottom}%`,
        left: `${waves.side}%`,
        right: `${waves.side}%`,
        zIndex: 2,
        maskImage: mask,
        WebkitMaskImage: mask,
        transition: `top ${MOVE}, bottom ${MOVE}, left ${MOVE}, right ${MOVE}`,
      }}
    >
      {children}
    </div>
  );
}
