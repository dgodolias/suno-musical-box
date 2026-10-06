// genres.json is the full MusicBrainz genre list (CC0):
// https://musicbrainz.org/ws/2/genre/all?fmt=txt
import musicbrainzGenres from "./genres.json";

// Styles Suno understands that MusicBrainz doesn't list; Greek ones are in
// Greeklish, as people type them (MusicBrainz already has byzantine chant,
// éntekhno, laiko, modern laiko, rebetiko and rizitika)
const GREEK_GENRES = [
  "ballos", "bouzouki", "cafe aman", "cretan lyra", "cretan music", "entechno",
  "epirus polyphonic song", "greek ballad", "greek dance", "greek folk", "greek folk dance",
  "greek hip hop", "greek indie", "greek lullaby", "greek pop", "greek rock", "greek trap",
  "hasapiko", "hasaposerviko", "kalamatianos", "kantades", "karsilamas", "mantinades",
  "nisiotika", "pentozali", "pontic music", "skyladiko", "smyrneiko", "syrtaki",
  "thracian folk", "tsamiko", "tsifteteli", "zeibekiko",
];
const EXTRA_GENRES = [
  "a cappella", "acoustic", "adult contemporary", "afropop", "andean folk", "arabic pop",
  "balkan beat", "balkan brass", "bollywood", "chamber music", "chillhop", "choral",
  "cinematic", "cinematic orchestral", "epic orchestral", "film score",
  "fingerstyle guitar", "hawaiian", "hybrid orchestral", "khaleeji", "meditation",
  "middle eastern", "mumble rap", "native american", "nordic folk", "retrowave",
  "scottish folk", "solo piano", "soulful house", "soundtrack", "trailer music",
  "uplifting trance", "video game music",
];

export const GENRES: string[] = Array.from(
  new Set([...musicbrainzGenres, ...GREEK_GENRES, ...EXTRA_GENRES])
).sort((a, b) => a.localeCompare(b));
