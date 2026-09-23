"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Eclipse, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

// Same three themes as educoach-platform's ModeToggle ("midnight" is Κοσμικό).
const THEMES = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "midnight", label: "Cosmic", Icon: Eclipse },
] as const;

export default function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  // False during SSR, true on the client, so the active theme only shows once known.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex items-center gap-0.5 rounded-full border border-border/60 bg-card p-1"
    >
      {THEMES.map(({ value, label, Icon }) => {
        const active = mounted && theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => setTheme(value)}
            className={cn(
              "flex size-8 items-center justify-center rounded-full transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            )}
          >
            <Icon className="size-4" />
          </button>
        );
      })}
    </div>
  );
}
