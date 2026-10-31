# Astral Web (alpha demo)

A small browser version of Astral Runshot, branded "Astral Web (alpha demo)": a first-person rhythm shooter. You run down the neon city
road with a rifle; boxes fly in at you and you shoot them on the beat. It reads the game's own song
format (`Docs/MapFormat.md`), so any song folder from the game plays here too. It's set up like the
game's dev preset (mouse look, box speed 30, target size 1.4, hit plane 25 m ahead, timing windows
x1.2) and has no obstacles.

It's a plain static site: HTML, CSS and JavaScript modules, no build step. three.js 0.169.0 is
loaded from jsDelivr.

## What's in it

- **Title:** the game's ASTRAL logo artwork (`logo.png`), then WEB and an ALPHA DEMO tag.
  FEEDBACK at the top links to https://lightkuro.itch.io/astral-r1.
- **Songs:** the built-in demo song (Neon Nowhere, Normal and Hard). On a computer, the + under the
  song list (or OPEN SONG FOLDER...) plays any song folder from the game (one with an `info.json`, like
  `Saved/Songs/<song>`, or a folder of them). Songs opened this way only stay until the page is
  reloaded.
- **osu! maps:** IMPORT OSU! MAP... (or dropping a `.osz` on the page) converts an osu! beatmap with
  a port of the game's converter (`AstralOsuConverter.cpp`). It covers all four modes, slider curves
  and repeats, spinners as holds, thinning to about N targets a second and kiai lights. Lane hazards,
  gates and track turns are left out because this version has none. Picking an osu! song folder
  with the + works too. Imported maps are kept in this browser (IndexedDB) as their original files,
  so Settings > osu! maps re-converts them. REMOVE deletes one.
- **Aiming:** MOUSE LOOK (default on a computer): the mouse turns the view within the game's limits
  (55 degrees each side, 50 up, 25 down) and the crosshair stays in the middle. The first click locks
  the pointer; `Esc` gives it back and pauses. Where the browser won't lock the pointer, the view
  follows the mouse instead. FREE CURSOR (default on phones) aims where you point or tap.
- **Shooting:** a plain first-person rifle with recoil and a tracer from the gun tip on every shot,
  straight down your aim (tracers move with you; they don't snap onto boxes). One shot per click;
  holding the trigger only matters for holds, where a beam shows while you track one. Settings:
  keep firing while held, muzzle flash and beam snaps to holds (all off by default).
- **Lanes:** `A` / `D` move between the chart's lanes (there are no obstacles to dodge).
- **Targets:** solid glowing boxes (magenta; cyan for holds) that fly in from the distance and reach
  the hit plane on the beat, each with a square timing frame that closes onto it, and the
  judgement shown just above (or at the top of the screen: Settings > Timing > Timing text). A hold's box rides a 3D tube laid out ahead of it along the track
  (its slider path: bezier / catmull / linear / arc, repeats); the part you've passed disappears.
- **Double / triple boxes** (off by default): quick taps on one spot share a box with a hit per tap,
  yellow with 2 hits left and red with 3, shown as a STACK (the next layer lowers into place after a
  hit) or ONE BOX.
- **Scene:** the neon city in the game's colours: dark road with thin lane lines, glowing edge rails
  and side barriers, towers with lit roof rims, violet fog. Kept simple so it stays fast.
- **Events:** speed changes, flashes, colour changes and FOV kicks (section names are not shown).
- **Judging:** the game's rules. Critical Perfect is the inner half of the Perfect window. Holds are
  graded LOCKED / GREAT / GOOD / BROKEN, with ticks, and score uses the same points and combo bonus.
- **Accuracy:** maimai DX style, 101%, with ranks D to SSS+.
- **Options:** AUTOPLAY and NO FAIL (on by default) on the song panel; SETTINGS (also in the pause
  menu, where most changes apply at once) in groups: aim and shooting (aim mode, sensitivity, keep
  firing), targets (size, double / triple boxes), timing (STRICT / STANDARD / LENIENT / RELAXED
  windows, box fly-in speed, how long targets show, and the audio offset with - / + buttons, a
  number box and a slider), crosshair (cross or dot, size,
  thickness, gap, colour, with a preview), audio volumes and graphics HIGH (glow) or LOW.
- **Phones:** tap (and hold) to shoot.
- **Storage:** settings and best scores are kept in the browser's local storage.

Not in it (yet): obstacles, the other maps, skins, the map editor, importing MP3 / osu! files, and
track turns.

### Controls

| Action | Keys |
|---|---|
| Aim | mouse (or touch) |
| Shoot | left click, `Z`, `X`, `J`, `K` (hold it on holds) |
| Change lane | `A` / `D`, `Left` / `Right` |
| Pause | `Esc`, `P` |
| Continue / quit (paused) | `Space` / `Esc` |
| Retry | `R` |
| Play (menu) | `Enter` |

## Run it locally

Browsers won't load modules from `file://`, so serve the folder:

```bash
python -m http.server 8137 --directory Web
```

Then open http://localhost:8137.

## Put it on Cloudflare (free)

**From GitHub:** this updates by itself on every push.

1. Cloudflare dashboard > Workers & Pages > Create > Pages > Connect to Git.
2. Pick the repository and the `main` branch.
3. Fill in the build settings:
   - Framework preset: None
   - Build command: leave empty
   - Build output directory: `Web`
4. Save and Deploy. The site goes live at `https://<project>.pages.dev`; a custom domain can be added
   under the project's Custom domains.

**Without Git:** upload just this folder.

```bash
npx wrangler pages deploy Web --project-name astral-runshot
```

The first run asks you to log in to Cloudflare.

The free plan is plenty for this. Static requests are free and unlimited, and the biggest file
(the song) is about 2.5 MB, well under the 25 MB limit per file. `_headers` sets caching for the
songs.

## Adding built-in songs

1. Copy a song folder into `songs/`: `info.json`, the charts, the audio and the cover.
2. Add its folder name to `songs/index.json`.

`.ogg` audio plays in Chrome, Edge and Firefox. Safari can't always decode it, so for the demo song
`info.json` also names `"audioFallback": "song.m4a"`, an AAC copy:

```bash
ffmpeg -i song.ogg -c:a aac -b:a 160k song.m4a
```

Only add songs you're allowed to share.

## Code

| File | What it does |
|---|---|
| `src/chart.js` | Loads songs and charts. Handles timing points (beats to seconds), the distance map (speed events) and hold paths. |
| `src/osu.js` | osu! import: reads .osz zips (the browser's own deflate), parses .osu files and converts them like `AstralOsuConverter.cpp`. Also keeps imported maps in IndexedDB. |
| `src/audio.js` | Web Audio. Provides the music clock (smoothed output timestamp) and the synthesized sound effects. |
| `src/world.js` | The three.js scene: road, barriers and city, target / frame / tube pools, the rifle, tracers, sparks, and the optional bloom. |
| `src/game.js` | One run. Handles fly-in, aiming, auto-fire, judging, holds, score and accuracy (the same numbers as `AAstralRunManager`), and autoplay. |
| `src/main.js` | Menus, settings, input and the main loop. |

For debugging, `window.astral` exposes the current run, the settings and the world.

## Credits

Every asset and library, with its source and license, is listed in [CREDITS.md](CREDITS.md).
