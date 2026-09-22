"use client";

import { useId } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { CheckIcon, ChevronDownIcon, XIcon } from "lucide-react";
import { GENRES } from "@/lib/genres";

interface GenrePickerProps {
  value: string | null;
  onChange: (genre: string | null) => void;
}

export default function GenrePicker({ value, onChange }: GenrePickerProps) {
  const inputId = useId();

  return (
    <Combobox.Root items={GENRES} value={value} onValueChange={onChange} autoHighlight>
      <div className="space-y-1.5">
        <label htmlFor={inputId} className="block text-xs text-muted-foreground">
          Genre
        </label>
        <div className="relative">
          <Combobox.Input
            id={inputId}
            placeholder="Search genres..."
            className="h-8 w-full rounded-lg border border-input bg-transparent pl-2.5 pr-14 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <div className="absolute inset-y-0 right-1 flex items-center">
            <Combobox.Clear
              aria-label="Clear genre"
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
            >
              <XIcon className="size-3.5" />
            </Combobox.Clear>
            <Combobox.Trigger
              aria-label="Show all genres"
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
            >
              <ChevronDownIcon className="size-4" />
            </Combobox.Trigger>
          </div>
        </div>
      </div>

      <Combobox.Portal>
        <Combobox.Positioner sideOffset={6} className="isolate z-50">
          <Combobox.Popup className="max-h-(--available-height) w-(--anchor-width) overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10">
            <Combobox.Empty className="py-2 text-center text-sm text-muted-foreground empty:hidden">
              No genre found
            </Combobox.Empty>
            <Combobox.List className="max-h-72 overflow-y-auto overscroll-contain p-1 data-empty:p-0">
              {(genre: string) => (
                <Combobox.Item
                  key={genre}
                  value={genre}
                  className="relative flex cursor-default items-center rounded-md py-1 pr-8 pl-2 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                >
                  {genre}
                  <Combobox.ItemIndicator className="absolute right-2 flex items-center">
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
