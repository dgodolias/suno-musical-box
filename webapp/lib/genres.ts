// genres.json is the full MusicBrainz genre list (CC0):
// https://musicbrainz.org/ws/2/genre/all?fmt=txt
import musicbrainzGenres from "./genres.json";

// Styles Suno understands that MusicBrainz doesn't list
const EXTRA_GENRES = [
  "a cappella", "acoustic", "adult contemporary", "afropop", "andean folk", "arabic pop",
  "balkan beat", "balkan brass", "bollywood", "chamber music", "chillhop", "choral",
  "cinematic", "cinematic orchestral", "cretan music", "epic orchestral", "film score",
  "fingerstyle guitar", "greek folk", "greek hip hop", "greek pop", "hawaiian",
  "hybrid orchestral", "khaleeji", "meditation", "middle eastern", "mumble rap",
  "native american", "nisiotika", "nordic folk", "pontic music", "retrowave",
  "scottish folk", "solo piano", "soulful house", "soundtrack", "syrtaki",
  "trailer music", "tsifteteli", "uplifting trance", "video game music", "zeibekiko",
];

export const GENRES: string[] = Array.from(
  new Set([...musicbrainzGenres, ...EXTRA_GENRES])
).sort((a, b) => a.localeCompare(b));
