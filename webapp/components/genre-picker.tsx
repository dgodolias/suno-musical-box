"use client";

import { useId, useRef } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { CheckIcon, ChevronDownIcon, SearchIcon, XIcon } from "lucide-react";
import { GENRES } from "@/lib/genres";

interface GenrePickerProps {
  value: string | null;
  onChange: (genre: string | null) => void;
}

// Styled after educoach-platform's search-select (onboarding) and dropdown menu:
// search icon + primary focus border, rounded-2xl popup, accent highlight,
// primary-tinted selected row with a check.
export default function GenrePicker({ value, onChange }: GenrePickerProps) {
  const inputId = useId();
  // Anchor the popup to the whole field (icon + input + buttons), not just the <input>.
  const fieldRef = useRef<HTMLDivElement>(null);

  return (
    <Combobox.Root items={GENRES} value={value} onValueChange={onChange} autoHighlight>
      <div className="space-y-1.5">
        <label htmlFor={inputId} className="block text-sm font-medium">
          Music style
        </label>
        <div
          ref={fieldRef}
          className="relative flex items-center rounded-xl border border-input bg-background transition-colors focus-within:border-primary focus-within:ring-3 focus-within:ring-ring/30">
          <SearchIcon className="ml-3 size-4 shrink-0 text-muted-foreground" />
          <Combobox.Input
            id={inputId}
            placeholder="Search genres..."
            className="h-10 w-full bg-transparent pl-2 pr-16 text-sm outline-none placeholder:text-muted-foreground"
          />
          <div className="absolute inset-y-0 right-1.5 flex items-center gap-0.5">
            <Combobox.Clear
              aria-label="Clear genre"
              className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <XIcon className="size-3.5" />
            </Combobox.Clear>
            <Combobox.Trigger
              aria-label="Show all genres"
              className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <ChevronDownIcon className="size-4" />
            </Combobox.Trigger>
          </div>
        </div>
      </div>

      <Combobox.Portal>
        <Combobox.Positioner anchor={fieldRef} sideOffset={6} className="isolate z-50">
          <Combobox.Popup className="max-h-(--available-height) w-(--anchor-width) overflow-hidden rounded-2xl border border-border/60 bg-popover text-popover-foreground shadow-sticker-sm transition-[opacity,transform] duration-150 data-starting-style:-translate-y-1 data-starting-style:opacity-0 data-ending-style:opacity-0">
            <Combobox.Empty className="px-4 py-3 text-center text-sm text-muted-foreground empty:hidden">
              No genre found
            </Combobox.Empty>
            <Combobox.List className="max-h-72 overflow-y-auto overscroll-contain p-1.5 data-empty:p-0">
              {(genre: string) => (
                <Combobox.Item
                  key={genre}
                  value={genre}
                  className="relative flex cursor-default items-center rounded-lg py-2 pr-9 pl-3 text-sm outline-none select-none transition-colors data-highlighted:bg-accent data-highlighted:text-accent-foreground data-selected:bg-primary/10 data-selected:font-medium data-selected:text-primary"
                >
                  {genre}
                  <Combobox.ItemIndicator className="absolute right-3 flex items-center text-primary">
                    <CheckIcon className="size-4" />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
