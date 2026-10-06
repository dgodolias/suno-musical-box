const SITE = "https://dimosthenisgkontolias.com";

// A badge whose border carries a neon light that runs round it, again and
// again, so the eye goes to it. The light is a short gradient moving along the
// badge's rounded outline (offset-path), seen only through a ring masked to
// the border itself, with a glow around it. Its styles travel with it (React
// puts them in <head> once), so it looks the same on every page whatever the
// global stylesheet holds.
const STYLES = `
.credit-badge {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 0.3em;
  padding: 0.4em 1em;
  border-radius: 9999px;
  border: 2px solid hsl(var(--primary) / 0.25);
  background: hsl(var(--card) / 0.75);
  color: hsl(var(--muted-foreground));
  box-shadow: 0 0 14px hsl(var(--primary) / 0.18);
  text-decoration: none;
  white-space: nowrap;
  transition: color 0.2s, border-color 0.2s, box-shadow 0.2s;
}
.credit-badge:hover {
  color: hsl(var(--foreground));
  border-color: hsl(var(--primary) / 0.5);
  box-shadow: 0 0 20px hsl(var(--primary) / 0.35);
}
.credit-badge strong {
  color: hsl(var(--foreground));
  font-weight: 600;
}
.credit-glow {
  position: absolute;
  inset: -2px;
  border-radius: inherit;
  pointer-events: none;
  filter: drop-shadow(0 0 3px hsl(322 95% 68%)) drop-shadow(0 0 8px hsl(252 90% 70% / 0.7));
}
.credit-beam {
  position: absolute;
  inset: 0;
  padding: 2px;
  border-radius: inherit;
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0);
}
.credit-beam::after {
  content: "";
  position: absolute;
  /* A thin streak, so it lights only the stretch of border it is on */
  width: 5em;
  height: 8px;
  background: linear-gradient(to left, #fff, hsl(322 95% 70%), hsl(252 90% 70%), transparent);
  offset-path: rect(0 auto auto 0 round 9999px);
  offset-anchor: 90% 50%;
  animation: credit-orbit 3.2s linear infinite;
}
@keyframes credit-orbit {
  to { offset-distance: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .credit-beam::after { animation: none; offset-distance: 20%; }
}
`;

/** "Created by dimosthenisgkontolias.com", linking to the site. */
export default function Credit({ className = "" }: { className?: string }) {
  return (
    <a
      href={SITE}
      target="_blank"
      rel="noopener noreferrer"
      // SyncWave goes full screen on double-click; not from here
      onDoubleClick={(event) => event.stopPropagation()}
      className={`credit-badge ${className}`}
    >
      <style href="musical-box-credit-streak" precedence="default">{STYLES}</style>
      <span aria-hidden className="credit-glow">
        <span className="credit-beam" />
      </span>
      Created by <strong>dimosthenisgkontolias.com</strong>
    </a>
  );
}
