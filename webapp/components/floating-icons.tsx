import {
  AudioLines,
  Disc3,
  Drum,
  Guitar,
  Headphones,
  HeartPulse,
  Mic,
  Music,
  Music2,
  Music4,
  Piano,
  Radio,
  Speaker,
} from "lucide-react";

// Same layout and motion as educoach-platform's onboarding FloatingIcons,
// with music icons instead of education ones. Desktop only: on narrow
// screens the side gutters are where the content is.
const ICONS = [
  // Left side
  { Icon: Music, x: "5%", y: "12%", size: 40, delay: 0, duration: 7 },
  { Icon: Headphones, x: "14%", y: "22%", size: 34, delay: 1.2, duration: 8 },
  { Icon: HeartPulse, x: "6%", y: "34%", size: 38, delay: 0.6, duration: 8.2 },
  { Icon: Guitar, x: "15%", y: "48%", size: 36, delay: 2, duration: 7.5 },
  { Icon: Mic, x: "5%", y: "60%", size: 32, delay: 1.8, duration: 7.8 },
  { Icon: Disc3, x: "13%", y: "74%", size: 34, delay: 0.3, duration: 9 },
  { Icon: Music2, x: "7%", y: "87%", size: 30, delay: 1.5, duration: 8.5 },
  // Right side
  { Icon: Piano, x: "92%", y: "12%", size: 38, delay: 1.5, duration: 8 },
  { Icon: AudioLines, x: "83%", y: "22%", size: 34, delay: 0.5, duration: 8.5 },
  { Icon: Radio, x: "91%", y: "36%", size: 36, delay: 0.3, duration: 9.5 },
  { Icon: Drum, x: "84%", y: "49%", size: 32, delay: 1, duration: 8.8 },
  { Icon: Speaker, x: "93%", y: "61%", size: 36, delay: 0.8, duration: 9 },
  { Icon: Music4, x: "84%", y: "74%", size: 34, delay: 2.2, duration: 7.2 },
  { Icon: HeartPulse, x: "91%", y: "87%", size: 30, delay: 1.7, duration: 8 },
];

export default function FloatingIcons() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 hidden overflow-hidden lg:block">
      {ICONS.map(({ Icon, x, y, size, delay, duration }, i) => (
        <div
          key={i}
          className="absolute text-primary/[0.12] motion-safe:animate-[icon-drift_var(--d)_ease-in-out_infinite]"
          style={
            {
              left: x,
              top: y,
              animationDelay: `${delay}s`,
              "--d": `${duration}s`,
            } as React.CSSProperties
          }
        >
          <Icon size={size} strokeWidth={1.5} />
        </div>
      ))}
    </div>
  );
}
